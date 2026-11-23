# PathViz

A small packet path visualizer for Linux. It shows which netfilter stages (PREROUTING, INPUT, FORWARD, OUTPUT, POSTROUTING and the raw, mangle, nat, filter positions in each) a packet crosses on the machine, live, in a web page.

It is built for learning and demos with a few packets per second. It favors correct and readable path visualization over the ability to handle large traffic volumes.

https://github.com/user-attachments/assets/da465c3e-42d9-4892-99f3-dd930da6c813

## How it works

A packet crosses a fixed chain of checkpoints on its way through the Linux network stack. PathViz puts an observer at every checkpoint. An observer only notes which packets passed by and never touches them.

PathViz collects the notes, finds the ones that belong to the same packet, and lights up the checkpoints this packet passed, visualizing the path of the packet in the kernel.

Under the hood:

1. The checkpoints are the five netfilter hooks and the stages (raw, mangle, nat, filter) inside them.
2. PathViz installs one nftables table, `inet pathviz`. The table has a probe chain right before every stage of every hook, and one more at the end of the hook.
3. The first probe that sees a packet matching the filter remembers the packet's identity (the IP ID, the TCP sequence numbers, and similar fields). The later probes recognize the packet by it, even after NAT rewrote its addresses or ports.
4. Every probe logs the packet to an NFLOG group and lets it go on unchanged.
5. PathViz reads the group, puts the records of one packet together, and draws the stages the packet was seen at. A packet that entered a stage and was never seen again is shown as stopped there.

The outcome of a packet is derived from the last probe that saw it:

- **Delivered locally** - the packet passed the end of INPUT.
- **Sent / Forwarded via `<device>`** - the packet passed the end of POSTROUTING.
- **Stopped in `<stage>`** - the packet entered a stage and was never seen again (e.g., a firewall rule dropped or rejected it).
- **Lost after `<hook>`** - the packet left a hook and never reached the next one (e.g. no route, or forwarding is disabled).

The probes coexist with iptables, nftables, and Docker rules. Stopping PathViz removes the table. If it was killed, run `pathviz cleanup` (or `nft delete table inet pathviz`).

## Demo

The quickest way to try PathViz without any setup is the [PathViz online playground](https://labs.iximiuz.com/playgrounds/pathviz). It is a regular Ubuntu VM with PathViz already running, its web UI open next to a terminal, and some demo traffic flowing (requires a free sign-in with GitHub).

The demo in the playground is a web server on port 8080 and a client that sends it a request every two seconds. The requests go over the loopback interface, so the page shows every packet cross four hooks: OUTPUT and POSTROUTING on its way out, then PREROUTING and INPUT on its way back in.

The same demo runs on any Linux machine with Go, `make`, `python3`, `curl`, and `nft`. It needs root, because PathViz installs an nftables table, so a throwaway machine is the best place for it:

```sh
git clone https://github.com/iximiuz/pathviz.git
cd pathviz
make demo-local
```

Then open http://127.0.0.1:7070 on that machine. `make demo-local-stop` stops the demo.

## Usage

Download the latest release binary to the machine to inspect:

```sh
arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
curl -L "https://github.com/iximiuz/pathviz/releases/latest/download/pathviz_linux_${arch}.tar.gz" | tar xz pathviz
sudo install -m 0755 pathviz /usr/local/bin/pathviz
```

Then run it. It needs root, `nft`, `ss`, and the `nfnetlink_log` kernel module:

```sh
sudo pathviz
```

Then open http://127.0.0.1:7070 on that machine. The page shows every packet until you set a filter in it.

The web UI listens on `127.0.0.1:7070` by default, so only the machine itself can open it. To open it from your own computer, forward the port over SSH:

```sh
ssh -L 7070:127.0.0.1:7070 <machine>
```

> [!CAUTION]
> The `--listen 0.0.0.0:7070` flag makes the UI reachable on every address of the machine. The UI has no login and no TLS, so use the flag only on a network you trust, such as a lab playground. Anyone who can reach the port can:
>
> - See the traced traffic: the addresses, the ports, the interfaces, and the names and PIDs of the processes with listening sockets.
> - Change the filter, and with it the nftables rules that PathViz (a root process) installs. A filter that matches all traffic logs every packet at every stage, which can slow down a busy machine.

To get some traffic to look at, start a web server on the machine and send requests to it:

```sh
python3 -m http.server 8080          # on the machine with PathViz
curl http://<machine>:8080/          # from another machine
```

Things to try while the traffic flows:

```sh
curl http://127.0.0.1:8080/                                                      # loopback crosses four hooks
ping -c 3 <another-machine>                                                      # OUTPUT and POSTROUTING, replies in PREROUTING and INPUT
sudo iptables -A INPUT -p tcp --dport 8080 -j DROP                               # stopped in filter/INPUT
sudo iptables -t nat -A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-ports 9090  # rewrite in nat/PREROUTING
```

## Limits

- A packet that matches the filter only after NAT rewrote it (e.g. the replies of a DNAT'ed connection, filtered by the original port) is shown from that stage on, and the page says so. Filter by something NAT does not change, such as the client address, to see such packets in full.
- The page shows which stages a packet crossed. It does not show which of your own rules matched.
- The web UI's own port (7070 by default) is never traced.
- The owning process is looked up with `ss` shortly after the packet was seen. A process that exits right after sending (e.g. a one-shot `curl`) may no longer be found, and kernel-generated packets (RST, ICMP replies) have no process.
- The output device of a packet is unknown in PREROUTING. With an output interface in the filter, the PREROUTING probes log every packet that satisfies the rest of the filter, and PathViz keeps only the packets that leave through that interface later. If the filter also has ports or addresses and NAT rewrites them in PREROUTING, such a packet is missed.
- Traffic is traced in the network namespace PathViz runs in.
- The web UI has no login. It listens on localhost by default for that reason (see the caution in "Usage"). The filter values are validated, and requests from other websites are rejected.
- If the kernel has to drop probe events (very busy filter), the page shows a warning and marks the affected packets, because a "stopped" outcome may then be wrong.

## Embedding on an existing page

PathViz can be embedded on an existing web page as an iframe (e.g., in a blog post).
The embedded page's layout can be configured via its URL, so a view of it can be put into an `<iframe>`:

| Parameter | Effect |
|---|---|
| `view=embed` | The diagram with its outcome line, under a header row with the view switch, the speed choice, and the connection badge. The filter fields and the tables are hidden, and the view is read-only: its interfaces, processes, and sockets cannot be clicked. |
| `tables=packets,stages` | In an embedded view: puts these tables below the diagram (`packets`, `stages`, or both). Without it, an embedded view has a "View: Path / Packets" switch in its header row, and the tables take the place of the diagram when it is flipped. In the full view: which tables are unfolded at first (`tables=` folds both, `tables=packets` folds the stages). A packet in the list can still be selected. |
| `detail=hooks` | One box per hook (PREROUTING, INPUT, ...) that lights up as a whole. A hook that rewrote the packet (NAT) turns amber, and a hook that stopped it turns red. The raw, mangle, nat, and filter stages are hidden, in the diagram, the texts, and the table. |
| `theme=dark` or `theme=light` | Forces the colors. Without it, the page follows the system setting. Works in the full view too. |
| `speed=0.5` | How fast a packet travels through the diagram, as a playback rate like in a video player: `1` is normal, and the range is `0.25` to `2` in steps of 0.25. The names `slow`, `medium`, and `fast` stand for 0.5, 1, and 1.5. Both views also have a Speed dropdown in the header. On a small screen the full view shows three chips in its place (x0.5, x1, x1.5). |
| `ifaces=eth0,lo` | Only these interface cards are drawn. |
| `procs=nginx,:8080` | Only these processes are drawn. An item is a process name or a port the process listens on. |
| `proto=tcp`, `port=8080,9000`, `ip=10.0.0.1`, `iface=in:eth0` | The display filter of an embedded view (see below). The values are the ones of the command-line flags. |

```html
<iframe src="https://<pathviz-url>/?view=embed&detail=hooks&port=8080&ifaces=eth0&procs=:8080" width="100%" height="460"></iframe>
```

### Several embeds of one PathViz

The filter of PathViz itself (the command-line flags, the fields and the clicks of the full view) decides what is traced, and it is the same for every page.

An embedded view has a display filter of its own on top. It shows only the traced packets that match it, so several embeds on one page can show different traffic:

1. Start `pathviz` with a filter that covers all the cases, e.g. `--proto tcp --port 8080,9000`.
2. Give every embed its own display filter in the URL, e.g. `port=8080` for the local flow and `iface=out:veth-app` for the forwarded one.

An embedded view never changes what PathViz traces. An address in `ip=` can be an IPv4 prefix (`10.0.0.0/8`). An IPv6 address must be written in full.

## Development

The code is a single Go module with the web page embedded in the binary. 
Optionally, the `playground.yaml` file describes a two-VM iximiuz Labs playground which is handy to use for development and testing:

```sh
labctl playground start flexbox -f playground.yaml
```

- The `dev` machine has the Go toolchain. Copy this folder there and run `make test` and `make deploy`.
- The `target` is a clean machine to inspect the traffic. `make deploy` installs the binary to `/usr/local/bin/pathviz` there.

There are two demos:

- `make demo-local` runs on one Linux machine (see "Demo" above).
- `make demo-playground` (on `dev`) uses both machines of the playground. PathViz runs on `target`, the requests come from `dev`, and there are two traffic flows to toggle between:

| Flow | From | To | Hooks on `target` | Pick it with |
|---|---|---|---|---|
| Local | `dev` | `target:8080`, a web server on `target` | PREROUTING, INPUT (replies: OUTPUT, POSTROUTING) | the `tcp :8080` socket |
| Forwarded | `dev` | `10.200.0.2:9000`, a web server in the `app` network namespace behind `target` | PREROUTING, FORWARD, POSTROUTING | the `veth-app` card (right for requests, left for replies) |
