#!/bin/sh
# Prepares the demo on the target machine. Run it as root (the Makefile's "demo-dev-playground" target does).
#
# It starts PathViz and two web servers (python3 -m http.server):
#   - on the target itself, port 8080 (traffic to it crosses PREROUTING and INPUT)
#   - in the "app" network namespace behind the target, 10.200.0.2:9000
#     (traffic to it crosses PREROUTING, FORWARD, and POSTROUTING)
set -eu

ip netns add app 2>/dev/null || true
ip link show veth-app >/dev/null 2>&1 || ip link add veth-app type veth peer name eth0 netns app
ip addr replace 10.200.0.1/24 dev veth-app
ip link set veth-app up
ip -n app addr replace 10.200.0.2/24 dev eth0
ip -n app link set eth0 up
ip -n app link set lo up
ip -n app route replace default via 10.200.0.1
sysctl -qw net.ipv4.ip_forward=1

for unit in pathviz pathviz-web pathviz-web-app; do
	systemctl stop "$unit" 2>/dev/null || true
	systemctl reset-failed "$unit" 2>/dev/null || true
done
mkdir -p /srv/pathviz-demo
echo "Hello from the PathViz demo!" > /srv/pathviz-demo/index.html
systemd-run --quiet --unit pathviz-web python3 -m http.server 8080 --directory /srv/pathviz-demo
systemd-run --quiet --unit pathviz-web-app ip netns exec app python3 -m http.server 9000 --directory /srv/pathviz-demo
# The filter covers both flows. A page narrows it down by a click or, when embedded, by its URL.
# The playground's pathviz tab reaches the UI from outside, so it cannot stay on localhost.
systemd-run --quiet --unit pathviz /usr/local/bin/pathviz --listen 0.0.0.0:7070 --proto tcp --port 8080,9000
