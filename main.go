// Command pathviz shows which netfilter stages a packet crosses on this machine.
//
// It installs a dedicated nftables table with one probe chain in front of every
// classic iptables stage (raw, mangle, nat, filter in each hook). The probes log
// the selected traffic to an NFLOG group, pathviz groups the log events by packet,
// and a web page draws the path of every packet.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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

// version is set by the release build (see .goreleaser.yaml).
var version = "dev"

const usage = `pathviz - see which netfilter stages a packet crosses

Usage:
  pathviz [run] [flags]      Install the probes and serve the web UI (needs root)
  pathviz rules [flags]      Print the nftables probe rules and exit
  pathviz cleanup            Remove the probes left behind by a killed pathviz
  pathviz version            Print the version and exit

Flags of "run" and "rules":
  --proto any|tcp|udp|icmp   Protocol to trace (default any)
  --ip <addr|cidr>[,...]     Trace packets from or to these addresses
  --iface <name>[,...]       Trace packets that enter or leave through these interfaces
                             (in:<name> only entering, out:<name> only leaving)
  --port <port>[,...]        Trace packets from or to these ports
  --listen <addr>            Address of the web UI (default 127.0.0.1:7070)
  --group <n>                NFLOG group to use (default 77)

Flags of "run":
  --token-file <path>        Take the access token of the web UI from this file
                             (or from PATHVIZ_TOKEN) instead of a new random one.
                             At least 16 characters, in a file only you can read
  --no-packet-view           Do not keep or show the contents of the packets
  --dangerously-skip-token   Serve the web UI without the access token: everyone
                             who can reach it can read the traced packets and
                             change the filter

"run" prints the address of the web UI with the access token in it.

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
	case "version":
		fmt.Println(version)
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
	noPacketView := fs.Bool("no-packet-view", false, "")
	tokenFile := fs.String("token-file", "", "")
	skipToken := fs.Bool("dangerously-skip-token", false, "")
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

	_, uiPortStr, err := net.SplitHostPort(*listen)
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
	fileToken := ""
	if *tokenFile != "" {
		if fileToken, err = readTokenFile(*tokenFile); err != nil {
			return err
		}
	}
	token, ownToken, err := pickToken(fileToken, os.Getenv("PATHVIZ_TOKEN"), *skipToken)
	if err != nil {
		return err
	}
	if os.Geteuid() != 0 {
		return errors.New("installing the probes needs root, run it with sudo")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	app := &App{group: *group, packetView: !*noPacketView, skipPorts: skipPorts, subs: map[chan []byte]bool{}, sockets: NewSocketTable(skipPorts)}
	app.token = token
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
	capture, err := StartCapture(ctx, *group, tracker, !*noPacketView)
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
	switch {
	case ownToken:
		// A token that outlives this run is kept out of the log.
		log.Printf("web UI on http://%s/?token=<your token>", ln.Addr())
	case app.token != "":
		log.Printf("web UI on http://%s/?token=%s", ln.Addr(), app.token)
	default:
		log.Printf("web UI on http://%s", ln.Addr())
		log.Printf("WARNING: the access token is off (--dangerously-skip-token). Everyone who can reach %s can read the traced packets and change the filter.", *listen)
	}
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// minTokenLen is the shortest access token pathviz accepts from the user.
const minTokenLen = 16

// readTokenFile reads an access token from a file. The token is not a flag of
// its own, because the other users of the machine can see the command line of
// a running program. For the same reason the file must be private.
func readTokenFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("cannot read the token file: %v", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("the token file %s is open to other users (mode %04o): run chmod 600 on it", path, info.Mode().Perm())
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read the token file: %v", err)
	}
	token := strings.TrimSpace(string(b))
	if token == "" {
		return "", fmt.Errorf("the token file %s is empty", path)
	}
	return token, nil
}

// pickToken returns the access token of the web UI: the one of the token file,
// else the one of the PATHVIZ_TOKEN variable, else a new random one.
// The token is empty when the check is off. own tells that the user chose it.
func pickToken(fileValue, envValue string, skip bool) (token string, own bool, err error) {
	token = fileValue
	if token == "" {
		token = envValue
	}
	switch {
	case skip && token != "":
		return "", false, errors.New("--dangerously-skip-token turns the access token off, so it cannot be combined with --token-file or PATHVIZ_TOKEN")
	case skip:
		return "", false, nil
	case token == "":
		token, err = newToken()
		if err != nil {
			return "", false, fmt.Errorf("cannot make the access token: %v", err)
		}
		return token, false, nil
	case len(token) < minTokenLen:
		return "", false, fmt.Errorf("the access token is too short: it needs at least %d characters", minTokenLen)
	}
	for _, c := range token {
		if c <= ' ' || c > '~' {
			return "", false, errors.New("the access token can hold only visible ASCII characters, without spaces")
		}
	}
	return token, true, nil
}

// newToken returns a random access token for the web UI.
func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
