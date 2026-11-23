package main

import (
	"encoding/binary"
	"math/rand"
	"strings"
	"testing"
)

// ipv4 wraps an L4 segment into an IPv4 header.
func ipv4(proto uint8, l4 []byte) []byte {
	b := make([]byte, 20, 20+len(l4))
	b[0] = 0x45
	binary.BigEndian.PutUint16(b[2:], uint16(20+len(l4)))
	binary.BigEndian.PutUint16(b[4:], 7)
	b[6] = 0x40
	b[8] = 64
	b[9] = proto
	copy(b[12:], []byte{10, 0, 0, 1})
	copy(b[16:], []byte{10, 0, 0, 2})
	return append(b, l4...)
}

func tcpSegment(sport, dport uint16, flags byte, options, payload []byte) []byte {
	b := make([]byte, 20, 20+len(options)+len(payload))
	binary.BigEndian.PutUint16(b[0:], sport)
	binary.BigEndian.PutUint16(b[2:], dport)
	binary.BigEndian.PutUint32(b[4:], 1000)
	b[12] = byte((20 + len(options)) / 4 << 4)
	b[13] = flags
	binary.BigEndian.PutUint16(b[14:], 64240)
	return append(append(b, options...), payload...)
}

func udpDatagram(sport, dport uint16, payload []byte) []byte {
	b := make([]byte, 8, 8+len(payload))
	binary.BigEndian.PutUint16(b[0:], sport)
	binary.BigEndian.PutUint16(b[2:], dport)
	binary.BigEndian.PutUint16(b[4:], uint16(8+len(payload)))
	return append(b, payload...)
}

func dnsResponse() []byte {
	b := []byte{0xbe, 0xef, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0}
	b = append(b, "\x07example\x03com\x00"...)
	b = append(b, 0, 1, 0, 1)
	// A CNAME and an A record. Their names point back into the message.
	b = append(b, 0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 6, 3, 'w', 'w', 'w', 0xc0, 12)
	b = append(b, 0xc0, 12, 0, 1, 0, 1, 0, 0, 1, 44, 0, 4, 93, 184, 216, 34)
	return b
}

func clientHello(host string) []byte {
	sni := []byte{0, 0, 0, byte(len(host) + 5), 0, byte(len(host) + 3), 0, 0, byte(len(host))}
	sni = append(sni, host...)
	alpn := []byte{0, 16, 0, 5, 0, 3, 2, 'h', '2'}
	exts := append(sni, alpn...)
	body := []byte{3, 3}
	body = append(body, make([]byte, 32)...)
	body = append(body, 0)                // session id
	body = append(body, 0, 2, 0x13, 0x01) // cipher suites
	body = append(body, 1, 0)             // compression
	body = append(body, byte(len(exts)>>8), byte(len(exts)))
	body = append(body, exts...)
	hs := append([]byte{1, 0, byte(len(body) >> 8), byte(len(body))}, body...)
	return append([]byte{22, 3, 1, byte(len(hs) >> 8), byte(len(hs))}, hs...)
}

func dhcpDiscover() []byte {
	b := make([]byte, 240)
	b[0], b[1], b[2] = 1, 1, 6
	copy(b[28:], []byte{0x02, 0x42, 0xac, 0x11, 0x00, 0x02})
	binary.BigEndian.PutUint32(b[236:], 0x63825363)
	return append(b, 53, 1, 1, 12, 4, 'h', 'o', 's', 't', 255)
}

func icmpUnreachable() []byte {
	quoted := ipv4(17, udpDatagram(40000, 9, nil))
	return ipv4(1, append([]byte{3, 3, 0, 0, 0, 0, 0, 0}, quoted...))
}

func samples() map[string][]byte {
	synOptions := []byte{2, 4, 5, 0xb4, 4, 2, 8, 10, 0, 0, 0, 1, 0, 0, 0, 0, 1, 3, 3, 7}
	v6 := make([]byte, 40)
	v6[0] = 0x60
	udp := udpDatagram(5000, 53, dnsResponse())
	binary.BigEndian.PutUint16(v6[4:], uint16(len(udp)))
	v6[6], v6[7], v6[23], v6[39] = 17, 64, 1, 2
	return map[string][]byte{
		"syn":   ipv4(6, tcpSegment(40000, 80, 0x02, synOptions, nil)),
		"http":  ipv4(6, tcpSegment(40000, 80, 0x18, nil, []byte("GET /a HTTP/1.1\r\nHost: example.com\r\n\r\nbody"))),
		"tls":   ipv4(6, tcpSegment(40000, 443, 0x18, nil, clientHello("example.com"))),
		"dns":   ipv4(17, udpDatagram(53, 40000, dnsResponse())),
		"dns6":  append(v6, udp...),
		"dhcp":  ipv4(17, udpDatagram(68, 67, dhcpDiscover())),
		"icmp":  icmpUnreachable(),
		"echo":  ipv4(1, []byte{8, 0, 0, 0, 0, 1, 0, 2, 'a', 'b', 'c'}),
		"other": ipv4(47, []byte{1, 2, 3, 4}),
	}
}

// field returns the value of the named field of the named layer.
func field(t *testing.T, d Dissection, layer, name string) string {
	t.Helper()
	for _, l := range d.Layers {
		if l.Name != layer {
			continue
		}
		for _, f := range l.Fields {
			if f.Name == name {
				return f.Value
			}
		}
	}
	t.Fatalf("no field %q in layer %q: %+v", name, layer, d.Layers)
	return ""
}

func TestDissectFields(t *testing.T) {
	s := samples()
	for _, c := range []struct{ sample, layer, name, want string }{
		{"syn", "IPv4", "Source Address", "10.0.0.1"},
		{"syn", "IPv4", "Flags", "DF (don't fragment)"},
		{"syn", "IPv4", "Protocol", "6 (TCP)"},
		{"syn", "TCP", "Destination Port", "80"},
		{"syn", "TCP", "Flags", "SYN"},
		{"syn", "TCP", "Option: Maximum Segment Size", "1460"},
		{"syn", "TCP", "Option: Window Scale", "7 (multiply by 128)"},
		{"syn", "TCP", "Option: Timestamps", "value 1, echo reply 0"},
		{"http", "HTTP", "Request Line", "GET /a HTTP/1.1"},
		{"http", "HTTP", "Host", "example.com"},
		{"tls", "TLS Client Hello", "Extension: Server Name", "example.com"},
		{"tls", "TLS Client Hello", "Extension: ALPN", "h2"},
		{"tls", "TLS Client Hello", "Cipher Suites", "1 suite"},
		{"dns", "DNS", "Question", "example.com, type A"},
		{"dns", "DNS", "Flags", "0x8180 (response, recursion desired, recursion available, no error)"},
		{"dns6", "IPv6", "Destination Address", "::2"},
		{"dns6", "DNS", "Question", "example.com, type A"},
		{"dhcp", "DHCP", "Option: Message Type", "1 (Discover)"},
		{"dhcp", "DHCP", "Client Hardware Address", "02:42:ac:11:00:02"},
		{"dhcp", "DHCP", "Option: Host Name", "host"},
		{"icmp", "ICMP", "Code", "3 (port unreachable)"},
		{"icmp", "IPv4 (quoted)", "Protocol", "17 (UDP)"},
		{"icmp", "UDP", "Destination Port", "9"},
		{"echo", "ICMP", "Sequence Number", "2"},
	} {
		if got := field(t, Dissect(s[c.sample]), c.layer, c.name); got != c.want {
			t.Errorf("%s: %s / %s = %q, want %q", c.sample, c.layer, c.name, got, c.want)
		}
	}

	d := Dissect(s["dns"])
	var answers []string
	for _, f := range d.Layers[2].Fields {
		if f.Name == "Answer" {
			answers = append(answers, f.Value)
		}
	}
	want := "example.com, type CNAME, TTL 60 s: www.example.com | example.com, type A, TTL 300 s: 93.184.216.34"
	if got := strings.Join(answers, " | "); got != want {
		t.Errorf("answers = %q, want %q", got, want)
	}
	if last := d.Layers[len(d.Layers)-1]; last.Name != "DNS" {
		t.Errorf("a fully decoded DNS message must leave no data, got a %q layer", last.Name)
	}
	if last := Dissect(s["http"]).Layers[3]; last.Name != "HTTP body" || last.Len != 4 {
		t.Errorf("unexpected HTTP body layer: %+v", last)
	}
}

// checkLayout verifies that the layers cover the packet without gaps or
// overlaps, and that every field lies inside its layer.
func checkLayout(t *testing.T, name string, d Dissection) {
	t.Helper()
	at := 0
	for _, l := range d.Layers {
		if l.Off != at || l.Len <= 0 {
			t.Fatalf("%s: layer %q covers %d+%d, expected to start at %d", name, l.Name, l.Off, l.Len, at)
		}
		at += l.Len
		for _, f := range l.Fields {
			if f.Len <= 0 || f.Off < l.Off || f.Off+f.Len > l.Off+l.Len {
				t.Fatalf("%s: field %q (%d+%d) is outside of layer %q (%d+%d)", name, f.Name, f.Off, f.Len, l.Name, l.Off, l.Len)
			}
		}
	}
	if at != len(d.Bytes) {
		t.Fatalf("%s: the layers cover %d of %d bytes", name, at, len(d.Bytes))
	}
}

func TestDissectLayout(t *testing.T) {
	rnd := rand.New(rand.NewSource(1))
	for name, b := range samples() {
		// The capture can cut a packet anywhere.
		for n := 0; n <= len(b); n++ {
			checkLayout(t, name, Dissect(b[:n]))
		}
		// Damaged packets must not break the dissector either.
		for i := 0; i < 3000; i++ {
			c := append([]byte(nil), b...)
			for k := rnd.Intn(4) + 1; k > 0; k-- {
				c[rnd.Intn(len(c))] = byte(rnd.Intn(256))
			}
			checkLayout(t, name, Dissect(c))
		}
	}
	if d := Dissect(samples()["http"][:50]); d.Total != 82 {
		t.Fatalf("total = %d, want the length from the IP header", d.Total)
	}
}
