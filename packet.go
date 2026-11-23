package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

// Packet is the decoded part of a packet that pathviz shows and compares.
type Packet struct {
	Proto   string     `json:"proto"` // tcp, udp, icmp, icmpv6, or the protocol number
	Src     netip.Addr `json:"src"`
	Dst     netip.Addr `json:"dst"`
	SrcPort uint16     `json:"sport,omitempty"`
	DstPort uint16     `json:"dport,omitempty"`
	TTL     uint8      `json:"ttl"`
	Len     int        `json:"len"`  // total length of the IP packet
	Info    string     `json:"info"` // short human-readable summary of the L4 header
	// Detail holds the longer L4 facts, e.g. the TCP sequence numbers.
	Detail string `json:"detail,omitempty"`

	// fingerprint identifies the packet across all hooks. It is built only from
	// the bytes that neither NAT nor forwarding rewrites.
	fingerprint string
}

// Endpoint formats an address with an optional port.
func Endpoint(a netip.Addr, port uint16, hasPorts bool) string {
	if !hasPorts {
		return a.String()
	}
	return netip.AddrPortFrom(a, port).String()
}

func (p Packet) hasPorts() bool { return p.Proto == "tcp" || p.Proto == "udp" }

// SrcString returns the source endpoint.
func (p Packet) SrcString() string { return Endpoint(p.Src, p.SrcPort, p.hasPorts()) }

// DstString returns the destination endpoint.
func (p Packet) DstString() string { return Endpoint(p.Dst, p.DstPort, p.hasPorts()) }

var errShort = errors.New("packet is too short")

// maxFingerprintPayload caps how many payload bytes take part in the fingerprint.
const maxFingerprintPayload = 48

// ParsePacket decodes an IP packet that starts at the network header.
// The data may be truncated after the headers (NFLOG copies only a prefix).
func ParsePacket(b []byte) (Packet, error) {
	if len(b) < 1 {
		return Packet{}, errShort
	}
	switch b[0] >> 4 {
	case 4:
		return parseIPv4(b)
	case 6:
		return parseIPv6(b)
	}
	return Packet{}, fmt.Errorf("unknown IP version %d", b[0]>>4)
}

func parseIPv4(b []byte) (Packet, error) {
	if len(b) < 20 {
		return Packet{}, errShort
	}
	ihl := int(b[0]&0x0f) * 4
	if ihl < 20 || len(b) < ihl {
		return Packet{}, errShort
	}
	var p Packet
	p.Len = int(binary.BigEndian.Uint16(b[2:4]))
	p.TTL = b[8]
	p.Src = netip.AddrFrom4([4]byte(b[12:16]))
	p.Dst = netip.AddrFrom4([4]byte(b[16:20]))
	proto := b[9]
	fragField := binary.BigEndian.Uint16(b[6:8])
	fragOffset := fragField & 0x1fff

	// NAT-invariant part of the IP header: ID, fragment offset and the MF bit,
	// protocol, and the L4 length.
	fp := make([]byte, 0, 96)
	fp = append(fp, 4, b[4], b[5], byte(fragField>>8)&0x3f, byte(fragField), proto)
	fp = binary.BigEndian.AppendUint16(fp, uint16(p.Len-ihl))

	if fragOffset != 0 {
		// A non-first fragment carries no L4 header.
		p.Proto = protoName(proto)
		p.Info = fmt.Sprintf("fragment, offset %d", int(fragOffset)*8)
		p.fingerprint = string(fp)
		return p, nil
	}
	parseL4(&p, proto, b[ihl:], p.Len-ihl, &fp)
	if fragField&0x2000 != 0 {
		p.Info = strings.TrimSpace(p.Info + " (first fragment)")
	}
	p.fingerprint = string(fp)
	return p, nil
}

func parseIPv6(b []byte) (Packet, error) {
	if len(b) < 40 {
		return Packet{}, errShort
	}
	var p Packet
	payloadLen := int(binary.BigEndian.Uint16(b[4:6]))
	p.Len = 40 + payloadLen
	p.TTL = b[7]
	p.Src = netip.AddrFrom16([16]byte(b[8:24]))
	p.Dst = netip.AddrFrom16([16]byte(b[24:40]))

	fp := make([]byte, 0, 96)
	fp = append(fp, 6, b[1]&0x0f, b[2], b[3]) // flow label
	fp = binary.BigEndian.AppendUint16(fp, uint16(payloadLen))

	// Skip the extension headers that can precede the L4 header.
	next := b[6]
	rest := b[40:]
	l4len := payloadLen
	for {
		switch next {
		case 0, 43, 60: // hop-by-hop, routing, destination options
			if len(rest) < 8 {
				p.Proto = protoName(next)
				p.fingerprint = string(fp)
				return p, nil
			}
			n := (int(rest[1]) + 1) * 8
			if len(rest) < n {
				p.Proto = protoName(next)
				p.fingerprint = string(fp)
				return p, nil
			}
			next, rest, l4len = rest[0], rest[n:], l4len-n
			continue
		case 44: // fragment
			if len(rest) < 8 {
				p.Proto = protoName(next)
				p.fingerprint = string(fp)
				return p, nil
			}
			fp = append(fp, rest[2:8]...) // offset, M flag, identification
			off := binary.BigEndian.Uint16(rest[2:4]) >> 3
			next, rest, l4len = rest[0], rest[8:], l4len-8
			if off != 0 {
				p.Proto = protoName(next)
				p.Info = fmt.Sprintf("fragment, offset %d", int(off)*8)
				p.fingerprint = string(fp)
				return p, nil
			}
			continue
		}
		break
	}
	fp = append(fp, next)
	parseL4(&p, next, rest, l4len, &fp)
	p.fingerprint = string(fp)
	return p, nil
}

func protoName(n uint8) string {
	switch n {
	case 1:
		return "icmp"
	case 6:
		return "tcp"
	case 17:
		return "udp"
	case 58:
		return "icmpv6"
	}
	return fmt.Sprint(n)
}

// parseL4 decodes the transport header and extends the fingerprint.
// l4len is the real length of the L4 header plus payload (b may be shorter).
func parseL4(p *Packet, proto uint8, b []byte, l4len int, fp *[]byte) {
	p.Proto = protoName(proto)
	payload := func(hdr int) []byte {
		if len(b) <= hdr {
			return nil
		}
		return b[hdr:min(len(b), hdr+maxFingerprintPayload)]
	}
	switch proto {
	case 6:
		if len(b) < 20 {
			return
		}
		p.SrcPort = binary.BigEndian.Uint16(b[0:2])
		p.DstPort = binary.BigEndian.Uint16(b[2:4])
		seq := binary.BigEndian.Uint32(b[4:8])
		ack := binary.BigEndian.Uint32(b[8:12])
		flags := b[13]
		dataLen := l4len - int(b[12]>>4)*4
		// Sequence numbers, flags, and the window survive NAT. Ports and the
		// checksum do not, and options can be rewritten (MSS clamping).
		*fp = append(*fp, b[4:12]...)
		*fp = append(*fp, flags, b[14], b[15])

		var names []string
		for _, f := range []struct {
			bit  byte
			name string
		}{{0x02, "SYN"}, {0x01, "FIN"}, {0x04, "RST"}, {0x08, "PSH"}, {0x10, "ACK"}, {0x20, "URG"}} {
			if flags&f.bit != 0 {
				names = append(names, f.name)
			}
		}
		p.Info = strings.Join(names, " ")
		if dataLen > 0 {
			p.Info += fmt.Sprintf(", %d bytes", dataLen)
		}
		p.Detail = fmt.Sprintf("seq=%d", seq)
		if flags&0x10 != 0 {
			p.Detail += fmt.Sprintf(" ack=%d", ack)
		}
	case 17:
		if len(b) < 8 {
			return
		}
		p.SrcPort = binary.BigEndian.Uint16(b[0:2])
		p.DstPort = binary.BigEndian.Uint16(b[2:4])
		*fp = append(*fp, b[4], b[5])
		*fp = append(*fp, payload(8)...)
		p.Info = fmt.Sprintf("%d bytes", l4len-8)
	case 1, 58:
		if len(b) < 8 {
			return
		}
		typ, code := b[0], b[1]
		*fp = append(*fp, typ, code)
		echo := (proto == 1 && (typ == 8 || typ == 0)) || (proto == 58 && (typ == 128 || typ == 129))
		if echo {
			// NAT can rewrite the echo ID, so only the sequence number and the
			// payload identify the packet.
			seq := binary.BigEndian.Uint16(b[6:8])
			*fp = append(*fp, b[6], b[7])
			*fp = append(*fp, payload(8)...)
			kind := "echo request"
			if typ == 0 || typ == 129 {
				kind = "echo reply"
			}
			p.Info = fmt.Sprintf("%s seq=%d", kind, seq)
		} else {
			p.Info = icmpName(proto, typ, code)
		}
	default:
		*fp = append(*fp, payload(0)...)
	}
}

func icmpName(proto, typ, code uint8) string {
	if proto == 1 {
		switch typ {
		case 3:
			names := map[uint8]string{0: "net unreachable", 1: "host unreachable", 3: "port unreachable", 4: "fragmentation needed", 13: "administratively prohibited"}
			if n, ok := names[code]; ok {
				return n
			}
			return fmt.Sprintf("destination unreachable (code %d)", code)
		case 5:
			return "redirect"
		case 11:
			return "time exceeded"
		}
	} else {
		switch typ {
		case 1:
			return fmt.Sprintf("destination unreachable (code %d)", code)
		case 2:
			return "packet too big"
		case 3:
			return "time exceeded"
		case 133:
			return "router solicitation"
		case 134:
			return "router advertisement"
		case 135:
			return "neighbor solicitation"
		case 136:
			return "neighbor advertisement"
		}
	}
	return fmt.Sprintf("type %d code %d", typ, code)
}
