# PathViz

PathViz is a small packet path visualizer for Linux. It shows how packets travel through the netfilter hooks (PREROUTING, INPUT, FORWARD, OUTPUT, POSTROUTING) and their stages (raw, mangle, nat, filter), live in your browser. You can see which stages a packet crosses, where it gets stopped, and how NAT changes it along the way.

PathViz is built for learning and demos with a few packets per second. The focus is on accurate, readable visualizations rather than handling large traffic volumes.

https://github.com/user-attachments/assets/da465c3e-42d9-4892-99f3-dd930da6c813

## How it works

As a packet travels through the Linux network stack, it passes through a series of netfilter hooks and stages.
PathViz places probes along this path to record where each packet goes, without modifying or interfering with it.
It then groups the records belonging to the same packet and lights up the stages it passed through.

Under the hood:

1. PathViz creates an nftables table, `inet pathviz`, with probe chains just before each stage (raw, mangle, nat, filter) and at the end of each of the five netfilter hooks.
2. The first probe that sees a packet matching the filter records its identity using fields such as the IP ID and TCP sequence numbers. Later probes use this identity to recognize the packet even if NAT changes its addresses or ports.
3. Each probe logs the packet to an NFLOG group and lets it continue unchanged.
4. PathViz reads the NFLOG records, matches them to individual packets, and reconstructs their paths. If a packet enters a stage but never reaches the next probe, PathViz marks it as stopped there.

The packet's outcome is determined by the last probe that saw it:

- **Delivered locally** - the packet reached the end of INPUT.
- **Sent / Forwarded via `<device>`** - the packet reached the end of POSTROUTING.
- **Stopped in `<stage>`** - the packet entered a stage but never came out (e.g., a firewall rule dropped or rejected it).
- **Lost after `<hook>`** - the packet left a hook but never reached the next one (e.g., because of a missing route or disabled IP forwarding).

Each packet also has an **Inspect** button. It opens a detailed view of the IP, TCP/UDP/ICMP headers, and payload, with decoded fields alongside a hex dump. DNS, HTTP, TLS handshakes, and DHCP are decoded too.

You can inspect the packet as it appeared at each probe. Fields that changed along the way, such as addresses or ports rewritten by NAT, are highlighted.

PathViz probes coexist with existing iptables, nftables, and Docker rules. Stopping PathViz removes its nftables table. If the process was killed, run `pathviz cleanup` (or `nft delete table inet pathviz`) to remove it manually.

## Demo

The easiest way to try PathViz is the [online playground](https://labs.iximiuz.com/playgrounds/pathviz). It's a regular Ubuntu VM with PathViz already running, its web UI open next to a terminal, and some demo traffic flowing. No installation is needed, just a free GitHub sign-in.

The demo runs a web server on port 8080 and a client that sends it a request every two seconds. Since the traffic goes over the loopback interface, each packet crosses four hooks: OUTPUT and POSTROUTING on its way out, then PREROUTING and INPUT on its way back in.

You can also run the same demo on any Linux machine with Go, `make`, `python3`, `curl`, and `nft` installed:

```sh
git clone https://github.com/iximiuz/pathviz.git
cd pathviz
make demo-local
```

PathViz needs root privileges to install its nftables table, so a throwaway VM is a good place to experiment.

Once the demo starts, open the URL it prints (`http://127.0.0.1:7070/?token=...`) in a browser on that machine. Run `make demo-local-stop` to stop it.

## Usage

Download the latest release binary to the Linux machine whose traffic you want to inspect:

```sh
arch=$(uname -m | sed 's/x86_64/amd64/; s/aarch64/arm64/')
curl -L "https://github.com/iximiuz/pathviz/releases/latest/download/pathviz_linux_${arch}.tar.gz" | tar xz pathviz
sudo install -m 0755 pathviz /usr/local/bin/pathviz
```

PathViz requires root privileges, `nft`, `ss`, and the `nfnetlink_log` kernel module.

Start it with:

```sh
sudo pathviz
```

The command prints the URL of the web UI:

```text
web UI on http://127.0.0.1:7070/?token=3f0c6a...
```

Open it in a browser on that machine. By default, PathViz shows all packets until you configure a filter in the UI.

### Accessing the web UI

PathViz generates a new access token on every start and includes it in the printed URL. The web UI requires this token for all requests.

Once you've opened the URL, the browser remembers the token, so you can use plain `http://127.0.0.1:7070` in the same browser until PathViz restarts. The token is kept in browser storage for that address and port, not in a cookie. Without a valid token, the page prompts you to enter one.

To use a persistent token, either:

- Store a token of at least 16 characters in a file readable only by its owner and pass `--token-file <path>`.
- Set the `PATHVIZ_TOKEN` environment variable.

By default, the web UI listens on `127.0.0.1:7070` and isn't accessible from other machines.

> [!CAUTION]
> **Treat the PathViz access token like a password.** Anyone with the token can:
>
> - See traced traffic, including IP addresses, ports, interfaces, and the names and PIDs of processes with listening sockets.
> - Inspect packet contents, including payloads that may contain cookies, tokens, or passwords. PathViz retains up to 2048 bytes per packet for inspection. Use `--no-packet-view` to disable packet inspection and avoid retaining packet bytes.
> - Change the capture filter and, consequently, the nftables rules installed by PathViz (which runs as root). A broad filter can capture sensitive traffic and slow down a busy machine.
>
> Keep in mind:
>
> - PathViz prints the access URL to its output. If it runs as a service, the token may also appear in its logs (e.g., `journalctl -u <unit>`).
> - The web UI uses plain HTTP, not HTTPS. If you expose it with `--listen 0.0.0.0:7070`, the token travels over the network unencrypted. Prefer SSH port forwarding or a TLS reverse proxy.
> - `--dangerously-skip-token` disables authentication entirely. Anyone who can reach the listening address can inspect traffic and change filters, including other local users and programs when listening on localhost. Use this option only in isolated, disposable environments with no sensitive traffic.

### Generating some traffic

Start a simple HTTP server on the machine running PathViz and send it a request from another machine:

```sh
python3 -m http.server 8080          # on the machine with PathViz
curl http://<machine>:8080/          # from another machine
```

Here are a few more things to try:

```sh
# Loopback traffic crosses four hooks
curl http://127.0.0.1:8080/

# OUTPUT and POSTROUTING, with replies going through PREROUTING and INPUT
ping -c 3 <another-machine>

# Drop incoming HTTP traffic in filter/INPUT
sudo iptables -A INPUT -p tcp --dport 8080 -j DROP

# Rewrite the destination port in nat/PREROUTING
sudo iptables -t nat -A PREROUTING -p tcp --dport 8080 -j REDIRECT --to-ports 9090
```

## Limits

PathViz is a learning tool, not a full-featured packet capture system. There are a few things to keep in mind:

- **NAT and capture filters.** If a packet matches the filter only after NAT changes it, PathViz can show its path only from that stage onward. For example, this can happen when filtering replies to a DNAT'ed connection by the original port. To capture the full path, filter by something NAT doesn't change, such as the client IP address.
- **Rule visibility.** PathViz shows which netfilter stages a packet crosses, but not which individual firewall rules matched it.
- **Web UI traffic.** PathViz never traces its own web UI port (7070 by default).
- **Process identification.** PathViz uses `ss` to look up the owning process shortly after a packet is seen. Short-lived processes, such as a one-shot `curl`, may have exited by then. Kernel-generated packets, such as TCP RSTs and ICMP replies, have no owning process.
- **Output interface filtering.** The output interface isn't known yet at PREROUTING. When filtering by output interface, PathViz initially records all packets matching the other filter conditions and keeps only those that later leave through the selected interface. Packets may be missed if the filter also includes addresses or ports that NAT rewrites in PREROUTING.
- **Network namespaces.** PathViz traces traffic only in the network namespace where it runs.
- **Packet inspection.** The packet view starts at the IP header (netfilter hooks don't expose the Ethernet header) and includes at most 2048 bytes. Each packet is decoded independently, without TCP stream reassembly. HTTP is recognized only in the segment where a message begins, and TLS only in handshake records. Checksums of locally generated packets may appear incomplete because the network card fills them in later.
- **Web UI security.** Access is controlled by a token, without user accounts or built-in TLS. Filter values are validated, and requests from other websites are rejected. See the security warning in the Usage section.
- **Dropped probe events.** Under heavy traffic, the kernel may drop some probe events. PathViz warns about this and marks affected packets, since their reported outcomes may be incorrect.

## Embedding on an existing page

PathViz can also be embedded in another web page, such as a blog post, using an `<iframe>`.

The embedded view can be customized through URL parameters:

| Parameter | Effect |
|---|---|
| `view=embed` | Shows a compact, read-only diagram with the packet outcome and header controls. The filter fields and tables are hidden by default, and interfaces, processes, and sockets aren't clickable. |
| `tables=packets,stages` | Shows the selected tables (`packets`, `stages`, or both) below the diagram. Without this parameter, the embedded view has a Path/Packets switch that replaces the diagram with the tables. In the full view, this parameter controls which tables are initially expanded (`tables=` collapses both). Packet selection remains available. |
| `detail=hooks` | Shows one box per netfilter hook instead of its individual stages. Hooks affected by NAT turn amber; hooks that stop a packet turn red. |
| `theme=dark` or `theme=light` | Overrides the system color scheme. Works in both embedded and full views. |
| `speed=0.5` | Controls packet animation speed, from `0.25` to `2` in steps of `0.25`. The aliases `slow`, `medium`, and `fast` correspond to `0.5`, `1`, and `1.5`. Speed can also be changed in the UI. |
| `ifaces=eth0,lo` | Shows only the selected interface cards. |
| `procs=nginx,:8080` | Shows only the selected processes, matched by name or listening port. |
| `proto=tcp`, `port=8080,9000`, `ip=10.0.0.1`, `iface=in:eth0` | Applies a display filter to the embedded view, using the same values as the corresponding command-line flags. |

For example:

```html
<iframe src="https://<pathviz-url>/?view=embed&detail=hooks&port=8080&ifaces=eth0&procs=:8080" width="100%" height="460"></iframe>
```

An embedded view needs an access token, just like the regular UI. You can either:

- Add `token=<token>` to the iframe URL, using a persistent token configured with `--token-file`.
- Run PathViz with `--dangerously-skip-token`.

**Be careful:** A token included in an iframe URL is visible to anyone who can access the embedding page. Use a dedicated PathViz instance in an isolated environment, and don't expose sensitive traffic.

### Multiple embeds from one PathViz instance

PathViz has two levels of filtering:

- **Capture filter** - configured through command-line flags or the full web UI. It determines which packets PathViz actually traces and is shared by all views.
- **Display filter** - configured through an embedded view's URL. It selects which of the already captured packets that particular view shows.

This lets you put several embeds on the same page, each showing a different traffic flow.

For example:

1. Start PathViz with a capture filter covering both flows: `--proto tcp --port 8080,9000`.
2. Give each embed its own display filter: `port=8080` for local traffic, `iface=out:veth-app` for forwarded traffic.

Embedded views never change the capture filter.

The `ip=` parameter also accepts IPv4 prefixes (e.g., `10.0.0.0/8`). IPv6 addresses must be written in full.

## Development

PathViz is a single Go module with the web UI embedded in the binary.

For development and testing, the repository includes `dev-playground.yaml`, which defines a two-VM [iximiuz Labs](https://labs.iximiuz.com/) playground:

- **`dev`** - the development machine with the Go toolchain, used for editing, testing, and building.
- **`target`** - a clean Linux machine for inspecting traffic. `make deploy` installs the binary to `/usr/local/bin/pathviz` on this machine.

To start the playground, run this command from the repository directory:

```sh
labctl playground start flexbox -f dev-playground.yaml --ssh
```

It opens an SSH session on the `dev` machine. To open another session later, use `labctl ssh <playground-id>` (`dev` is the default machine).

Clone the repository on `dev`, run the tests, and deploy the binary to `target`:

```sh
git clone https://github.com/iximiuz/pathviz.git
cd pathviz
make test
make deploy
```

To start a demo using both machines, run:

```sh
make demo-dev-playground
```

PathViz runs on `target`, while `dev` generates traffic. The demo includes two flows you can switch between:

| Flow | Source | Destination | Hooks on `target` | Select using |
|---|---|---|---|---|
| Local | `dev` | `target:8080`, a web server running on `target` | PREROUTING, INPUT (replies: OUTPUT, POSTROUTING) | The `tcp :8080` socket |
| Forwarded | `dev` | `10.200.0.2:9000`, a web server in the `app` network namespace behind `target` | PREROUTING, FORWARD, POSTROUTING | The `veth-app` card (right for requests, left for replies) |
