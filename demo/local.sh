#!/bin/sh
# The demo on a single Linux machine. Run it as root (the Makefile's "demo-local"
# and "demo-local-stop" targets do):
#
#   local.sh start <path to the pathviz binary> [address of the web UI]
#   local.sh stop
#
# "start" runs three processes on the machine:
#   - a web server on port 8080 (python3 -m http.server)
#   - a client that sends it a request every two seconds (curl)
#   - PathViz, which traces the packets of port 8080
# The requests go over the loopback interface, so every packet crosses OUTPUT
# and POSTROUTING on its way out and PREROUTING and INPUT on its way back in.
set -eu

UNITS="pathviz-local-daemon pathviz-local-web pathviz-local-send"

stop() {
	for unit in $UNITS; do
		systemctl stop "$unit" 2>/dev/null || true
		systemctl reset-failed "$unit" 2>/dev/null || true
	done
	rm -rf /tmp/pathviz-demo
}

start() {
	bin="$1"
	listen="${2:-127.0.0.1:7070}"
	stop

	mkdir -p /tmp/pathviz-demo
	echo "Hello from the PathViz demo!" > /tmp/pathviz-demo/index.html
	systemd-run --quiet --unit pathviz-local-web python3 -m http.server 8080 --directory /tmp/pathviz-demo
	# A web UI that other machines can reach must be confirmed. The traffic of
	# the demo holds no secrets, so its packets may be read from outside.
	danger=""
	case "$listen" in
		127.*|localhost:*) ;;
		*) danger="--dangerously-listen-on-network" ;;
	esac
	# shellcheck disable=SC2086
	systemd-run --quiet --unit pathviz-local-daemon "$bin" --listen "$listen" $danger --proto tcp --port 8080
	systemd-run --quiet --unit pathviz-local-send \
		sh -c 'while true; do curl -s -m 2 -o /dev/null http://127.0.0.1:8080/; sleep 2; done'

	echo "The demo runs. The web UI is on http://$listen."
	echo "Stop it with: make demo-local-stop"
}

case "${1:-}" in
start)
	[ -n "${2:-}" ] || { echo "usage: $0 start <path to the pathviz binary> [address of the web UI]" >&2; exit 1; }
	start "$2" "${3:-}"
	;;
stop)
	stop
	;;
*)
	echo "usage: $0 start <path to the pathviz binary> [address of the web UI] | stop" >&2
	exit 1
	;;
esac
