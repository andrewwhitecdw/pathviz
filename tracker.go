package main

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

// Event is one probe hit: a packet seen at the entry of a stage (or at the exit of a hook).
type Event struct {
	Time   time.Time
	Hook   string
	Stage  string
	In     string
	Out    string
	Mark   uint32
	Packet Packet
	// Raw is the captured part of the packet, from the IP header on. It is nil
	// when the packet view is disabled.
	Raw []byte
}

// Hop is an Event as it is shown to the user.
type Hop struct {
	Hook  string `json:"hook"`
	Stage string `json:"stage"`
	Exit  bool   `json:"exit,omitempty"`
	In    string `json:"in,omitempty"`
	Out   string `json:"out,omitempty"`
	Src   string `json:"src"`
	Dst   string `json:"dst"`
	TTL   uint8  `json:"ttl"`
	Mark  uint32 `json:"mark,omitempty"`
	// Micros is the time since the first hop of the journey.
	Micros int64 `json:"us"`
	// Rewrote describes what this stage changed in the packet, if anything.
	// It is known because the next probe saw different addresses.
	Rewrote string `json:"rewrote,omitempty"`
}

// Verdict kinds.
const (
	VerdictDelivered = "delivered" // passed INPUT, handed to the local transport layer
	VerdictSent      = "sent"      // passed POSTROUTING, handed to the output device
	VerdictStopped   = "stopped"   // entered a stage or a routing step and was never seen again
)

// Journey is the path of one packet through the hooks.
type Journey struct {
	ID    uint64    `json:"id"`
	Time  time.Time `json:"time"`
	Proto string    `json:"proto"`
	Src   string    `json:"src"` // as first seen
	Dst   string    `json:"dst"`
	Len   int       `json:"len"`
	Info  string    `json:"info"`
	// Detail holds the longer L4 facts, e.g. the TCP sequence numbers.
	Detail string `json:"detail,omitempty"`
	Hops   []Hop  `json:"hops"`

	Verdict string `json:"verdict"`
	// StoppedHook and StoppedStage tell where a stopped packet was last seen.
	// StoppedStage is "routing" when the packet left the hook and got lost before the next one.
	StoppedHook  string `json:"stoppedHook,omitempty"`
	StoppedStage string `json:"stoppedStage,omitempty"`
	// Path is the sequence of hooks, e.g. "PREROUTING INPUT".
	Path []string `json:"path"`
	// From is the local process that sent the packet, and To is the local
	// process that received it. They are nil when unknown or not applicable.
	From *Owner `json:"from,omitempty"`
	To   *Owner `json:"to,omitempty"`
	// Partial is set when the first hop is not the first stage of PREROUTING or
	// OUTPUT. The packet started to match the filter only at that stage (e.g.
	// after NAT rewrote it), so the earlier part of its path is unknown.
	Partial bool `json:"partial,omitempty"`
	// Unreliable is set when probe events were lost around this journey,
	// so a "stopped" verdict may be wrong.
	Unreliable bool `json:"unreliable,omitempty"`

	lastSeen time.Time
	seen     map[[2]string]bool
	// raw holds the captured bytes of the packet at every hop, in the order of Hops.
	raw [][]byte
}

const (
	// idleTimeout is how long a journey waits for more hops. All hooks of one
	// packet fire within microseconds, so this is generous.
	idleTimeout = 200 * time.Millisecond
	// lossWindow marks journeys around a lost probe event as unreliable.
	lossWindow = time.Second
)

// Tracker groups events into journeys.
type Tracker struct {
	mu       sync.Mutex
	open     map[string]*Journey
	nextID   uint64
	lastLoss time.Time
	emit     func(*Journey)
}

// NewTracker creates a tracker that calls emit for every finished journey.
// The emit function is called with the tracker locked and must not block.
func NewTracker(emit func(*Journey)) *Tracker {
	return &Tracker{open: map[string]*Journey{}, emit: emit}
}

// Add records one event.
func (t *Tracker) Add(ev Event) {
	t.mu.Lock()
	defer t.mu.Unlock()

	key := ev.Packet.fingerprint
	stage := [2]string{ev.Hook, ev.Stage}
	j := t.open[key]
	if j != nil && (j.seen[stage] || ev.Time.Sub(j.lastSeen) > idleTimeout) {
		// The same packet cannot enter a stage twice, so this is another packet
		// that looks the same (e.g. a duplicate ACK).
		t.finish(key, j)
		j = nil
	}
	if j == nil {
		t.nextID++
		j = &Journey{
			ID:     t.nextID,
			Time:   ev.Time,
			Proto:  ev.Packet.Proto,
			Src:    ev.Packet.SrcString(),
			Dst:    ev.Packet.DstString(),
			Len:    ev.Packet.Len,
			Info:   ev.Packet.Info,
			Detail: ev.Packet.Detail,
			seen:   map[[2]string]bool{},
		}
		t.open[key] = j
	}
	j.seen[stage] = true
	j.lastSeen = ev.Time
	j.raw = append(j.raw, ev.Raw)
	j.Hops = append(j.Hops, Hop{
		Hook:   ev.Hook,
		Stage:  ev.Stage,
		Exit:   ev.Stage == exitStage,
		In:     ev.In,
		Out:    ev.Out,
		Src:    ev.Packet.SrcString(),
		Dst:    ev.Packet.DstString(),
		TTL:    ev.Packet.TTL,
		Mark:   ev.Mark,
		Micros: ev.Time.Sub(j.Time).Microseconds(),
	})
}

// Lost records that probe events were lost at the given time.
func (t *Tracker) Lost(at time.Time) {
	t.mu.Lock()
	t.lastLoss = at
	t.mu.Unlock()
}

// Flush finishes the journeys that have been idle for long enough.
func (t *Tracker) Flush(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var done []string
	for key, j := range t.open {
		if now.Sub(j.lastSeen) > idleTimeout {
			done = append(done, key)
		}
	}
	// Emit in the order the packets were first seen.
	sort.Slice(done, func(a, b int) bool { return t.open[done[a]].ID < t.open[done[b]].ID })
	for _, key := range done {
		t.finish(key, t.open[key])
	}
}

func (t *Tracker) finish(key string, j *Journey) {
	delete(t.open, key)
	finalize(j)
	if !t.lastLoss.IsZero() && j.Time.Sub(t.lastLoss) < lossWindow && t.lastLoss.Sub(j.lastSeen) < lossWindow {
		j.Unreliable = true
	}
	t.emit(j)
}

// finalize derives the path, the rewrites, and the verdict from the hops.
func finalize(j *Journey) {
	for i := range j.Hops {
		h := &j.Hops[i]
		if len(j.Path) == 0 || j.Path[len(j.Path)-1] != h.Hook {
			j.Path = append(j.Path, h.Hook)
		}
		// A stage rewrote the packet when the next probe of the same hook saw
		// different addresses.
		if i+1 < len(j.Hops) && !h.Exit && j.Hops[i+1].Hook == h.Hook {
			n := j.Hops[i+1]
			if n.Dst != h.Dst {
				h.Rewrote = fmt.Sprintf("destination %s to %s", h.Dst, n.Dst)
			}
			if n.Src != h.Src {
				if h.Rewrote != "" {
					h.Rewrote += ", "
				}
				h.Rewrote += fmt.Sprintf("source %s to %s", h.Src, n.Src)
			}
		}
	}

	first := j.Hops[0]
	j.Partial = !((first.Hook == "PREROUTING" || first.Hook == "OUTPUT") && first.Stage == "raw")

	last := j.Hops[len(j.Hops)-1]
	switch {
	case last.Exit && last.Hook == "INPUT":
		j.Verdict = VerdictDelivered
	case last.Exit && last.Hook == "POSTROUTING":
		j.Verdict = VerdictSent
	case last.Exit:
		// The packet survived the hook but never showed up in the next one.
		j.Verdict = VerdictStopped
		j.StoppedHook = last.Hook
		j.StoppedStage = "routing"
	default:
		j.Verdict = VerdictStopped
		j.StoppedHook = last.Hook
		j.StoppedStage = last.Stage
	}
}
