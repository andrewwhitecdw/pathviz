// Command pathviz shows which netfilter stages a packet crosses on this machine.
//
// It installs a dedicated nftables table with one probe chain in front of every
// classic iptables stage (raw, mangle, nat, filter in each hook). The probes log
// the selected traffic to an NFLOG group, pathviz groups the log events by packet,
// and a web page draws the path of every packet.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const usage = `pathviz - see which netfilter stages a packet crosses

Usage:
  pathviz [run] [flags]      Install the probes and serve the web UI (needs root)
  pathviz rules [flags]      Print the nftables probe rules and exit
  pathviz cleanup            Remove the probes left behind by a killed pathviz

Flags of "run" and "rules":
  --proto any|tcp|udp|icmp   Protocol to trace (default any)
  --ip <addr|cidr>[,...]     Trace packets from or to these addresses
  --iface <name>[,...]       Trace packets that enter or leave through these interfaces
                             (in:<name> matches only entering, out:<name> only leaving)
  --port <port>[,...]        Trace packets from or to these ports
  --listen <addr>            Address of the web UI (default 127.0.0.1:7070).
                             The UI has no login: do not expose it to an
                             untrusted network (e.g. with 0.0.0.0:7070)
  --group <n>                NFLOG group to use (default 77)

Examples:
  sudo pathviz
  sudo pathviz --proto tcp --port 8080
  sudo pathviz --ip 172.16.0.10 --proto icmp
`

func main() {
	log.SetFlags(log.Ltime)
	args := os.Args[1:]
	cmd := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, args = args[0], args[1:]
	}
	var err error
	switch cmd {
	case "run":
		err = cmdRun(args, false)
	case "rules":
		err = cmdRun(args, true)
	case "cleanup":
		err = RemoveProbes()
	case "help":
		fmt.Print(usage)
	default:
		err = fmt.Errorf("unknown command %q, see pathviz --help", cmd)
	}
	if err != nil && !errors.Is(err, flag.ErrHelp) {
		fmt.Fprintln(os.Stderr, "pathviz:", err)
		os.Exit(1)
	}
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.Usage = func() { fmt.Fprint(os.Stderr, usage) }
	return fs
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ' ' }) {
		out = append(out, p)
	}
	return out
}

func cmdRun(args []string, rulesOnly bool) error {
	fs := newFlagSet("run")
	proto := fs.String("proto", "any", "")
	ips := fs.String("ip", "", "")
	ports := fs.String("port", "", "")
	ifaces := fs.String("iface", "", "")
	listen := fs.String("listen", "127.0.0.1:7070", "")
	group := fs.Int("group", 77, "")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	if *group < 1 || *group > 65535 {
		return fmt.Errorf("bad NFLOG group %d", *group)
	}

	f := Filter{Proto: *proto, IPs: splitList(*ips), Ifaces: splitList(*ifaces)}
	for _, p := range splitList(*ports) {
		n, err := strconv.Atoi(p)
		if err != nil {
			return fmt.Errorf("bad port %q", p)
		}
		f.Ports = append(f.Ports, n)
	}
	if err := f.Normalize(); err != nil {
		return err
	}

	uiHost, uiPortStr, err := net.SplitHostPort(*listen)
	if err != nil {
		return fmt.Errorf("bad --listen address: %v", err)
	}
	uiPort, err := strconv.Atoi(uiPortStr)
	if err != nil || uiPort < 1 || uiPort > 65535 {
		return fmt.Errorf("bad --listen port %q", uiPortStr)
	}
	skipPorts := []int{uiPort}

	if rulesOnly {
		fmt.Print(Ruleset(f, *group, skipPorts))
		return nil
	}
	if os.Geteuid() != 0 {
		return errors.New("installing the probes needs root, run it with sudo")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app := &App{group: *group, skipPorts: skipPorts, subs: map[chan []byte]bool{}, sockets: NewSocketTable(skipPorts)}
	app.RefreshHost()

	// The tracker must not wait for the socket lookups of a finished journey,
	// so the journeys go through a queue.
	finished := make(chan *Journey, 4096)
	tracker := NewTracker(func(j *Journey) { finished <- j })
	go func() {
		for j := range finished {
			app.OnJourney(j)
		}
	}()
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				app.RefreshHost()
			}
		}
	}()

	// Bind to the NFLOG group before the probes exist, so no event is missed.
	capture, err := StartCapture(ctx, *group, tracker)
	if err != nil {
		return err
	}
	defer func() {
		stop() // let the reader see the cancelled context before the socket closes
		capture.Close()
	}()
	app.lostFn = capture.LostEvents

	if err := app.SetFilter(f); err != nil {
		return err
	}
	defer func() {
		if err := RemoveProbes(); err != nil {
			log.Printf("cannot remove the probes: %v", err)
		} else {
			log.Printf("probes removed")
		}
	}()

	go func() {
		tick := time.NewTicker(50 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				tracker.Flush(now)
			}
		}
	}()

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: app.Handler()}
	go func() {
		<-ctx.Done()
		srv.Close()
	}()
	log.Printf("probes installed (nft list table inet %s)", tableName)
	log.Printf("web UI on http://%s", ln.Addr())
	if !loopbackHost(uiHost) {
		log.Printf("WARNING: the web UI listens on %s and has no login. Anyone who can reach this port can see the traced packets and change the filter. Use --listen 127.0.0.1:%s unless the network is trusted.", *listen, uiPortStr)
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// loopbackHost tells whether a listen host is reachable from this machine only.
// An empty host and 0.0.0.0 (or ::) mean all the addresses of the machine.
func loopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
