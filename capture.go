package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	nflog "github.com/florianl/go-nflog/v2"
)

// copyRange is how many bytes of every packet the kernel copies to pathviz.
// The headers and the fingerprinted payload prefix fit with a wide margin.
const copyRange = 256

// Capture reads probe events from an NFLOG group.
type Capture struct {
	ctx     context.Context
	nf      *nflog.Nflog
	tracker *Tracker

	mu      sync.Mutex
	ifnames map[uint32]string
	lastSeq uint32
	haveSeq bool
	lost    uint64
}

// StartCapture binds to the NFLOG group and feeds the tracker until ctx is done.
func StartCapture(ctx context.Context, group int, tracker *Tracker) (*Capture, error) {
	nf, err := nflog.Open(&nflog.Config{
		Group:    uint16(group),
		Copymode: nflog.CopyPacket,
		Bufsize:  copyRange,
		// Deliver every packet right away instead of batching.
		QThresh: 1,
		// Per-group sequence numbers reveal lost events.
		Flags: nflog.FlagSeq,
	})
	if err != nil {
		return nil, fmt.Errorf("open NFLOG group %d: %w", group, err)
	}
	if err := nf.Con.SetReadBuffer(8 << 20); err != nil {
		log.Printf("warning: cannot enlarge the netlink buffer: %v", err)
	}
	c := &Capture{ctx: ctx, nf: nf, tracker: tracker, ifnames: map[uint32]string{}}
	if err := nf.RegisterWithErrorFunc(ctx, c.onPacket, c.onError); err != nil {
		nf.Close()
		return nil, fmt.Errorf("register NFLOG handler: %w", err)
	}
	return c, nil
}

// Close releases the NFLOG socket.
func (c *Capture) Close() { c.nf.Close() }

// LostEvents returns how many probe events were lost so far.
func (c *Capture) LostEvents() uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lost
}

func (c *Capture) onError(err error) int {
	if c.ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
		return 1 // shutting down
	}
	// ENOBUFS and friends mean the kernel dropped events for this socket.
	now := time.Now()
	c.mu.Lock()
	c.lost++
	c.mu.Unlock()
	c.tracker.Lost(now)
	log.Printf("capture error: %v", err)
	return 0
}

func (c *Capture) onPacket(a nflog.Attribute) int {
	now := time.Now()
	if a.Seq != nil {
		c.mu.Lock()
		gap := c.haveSeq && *a.Seq != c.lastSeq+1
		if gap {
			c.lost += uint64(*a.Seq - c.lastSeq - 1)
		}
		c.lastSeq, c.haveSeq = *a.Seq, true
		c.mu.Unlock()
		if gap {
			c.tracker.Lost(now)
		}
	}
	if a.Prefix == nil || a.Payload == nil {
		return 0
	}
	stage, hook, ok := strings.Cut(*a.Prefix, "/")
	if !ok {
		return 0
	}
	pkt, err := ParsePacket(*a.Payload)
	if err != nil {
		log.Printf("skip packet at %s: %v", *a.Prefix, err)
		return 0
	}
	ev := Event{Time: now, Hook: hook, Stage: stage, Packet: pkt}
	if a.InDev != nil {
		ev.In = c.ifname(*a.InDev)
	}
	if a.OutDev != nil {
		ev.Out = c.ifname(*a.OutDev)
	}
	if a.Mark != nil {
		ev.Mark = *a.Mark
	}
	c.tracker.Add(ev)
	return 0
}

func (c *Capture) ifname(idx uint32) string {
	if idx == 0 {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if n, ok := c.ifnames[idx]; ok {
		return n
	}
	name := fmt.Sprintf("if%d", idx)
	if ifc, err := net.InterfaceByIndex(int(idx)); err == nil {
		name = ifc.Name
		c.ifnames[idx] = name
	}
	return name
}
