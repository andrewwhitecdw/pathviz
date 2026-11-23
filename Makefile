# build, test, and demo-local run on any Linux machine with Go. deploy and
# demo-playground run on the dev machine of the playground (see playground.yaml).
TARGET ?= target
TARGET_IP ?= 172.16.0.20
# The address of the web UI in the local demo.
LISTEN ?= 127.0.0.1:7070

.PHONY: build test deploy demo-local demo-local-stop demo-playground

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/pathviz .

test:
	go vet ./...
	go test ./...

# Copy the binary to the target machine.
deploy: build
	scp -q -o StrictHostKeyChecking=accept-new bin/pathviz $(TARGET):/tmp/pathviz
	ssh -nT $(TARGET) 'sudo install -m 0755 /tmp/pathviz /usr/local/bin/pathviz'

# The demo on this machine alone: PathViz, a web server, and a client that
# sends it requests over the loopback interface (see demo/local.sh). It needs
# root, python3, and curl. To reach the web UI from
# outside of the machine: make demo-local LISTEN=0.0.0.0:7070
demo-local: build
	sudo sh demo/local.sh start $(CURDIR)/bin/pathviz $(LISTEN)

demo-local-stop:
	sudo sh demo/local.sh stop

# The demo in the playground: PathViz and two web servers on the target, two
# request loops here (on the dev machine).
#   - the local flow goes to the target itself (PREROUTING, INPUT)
#   - the forwarded flow goes to a network namespace behind the target (FORWARD)
demo-playground: deploy
	ssh -T $(TARGET) 'sudo sh -s' < demo/target.sh
	sudo ip route replace 10.200.0.0/24 via $(TARGET_IP)
	-sudo systemctl stop pathviz-send-local pathviz-send-forward 2>/dev/null
	-sudo systemctl reset-failed pathviz-send-local pathviz-send-forward 2>/dev/null
	sudo systemd-run --quiet --unit pathviz-send-local sh -c 'while true; do curl -s -m 2 -o /dev/null http://$(TARGET_IP):8080/; sleep 2; done'
	sudo systemd-run --quiet --unit pathviz-send-forward sh -c 'while true; do curl -s -m 2 -o /dev/null http://10.200.0.2:9000/; sleep 2; done'
	@echo "The demo runs. Open http://$(TARGET_IP):7070 (or the playground's pathviz tab)."
