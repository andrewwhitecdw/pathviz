package main

import (
	"crypto/subtle"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

// backlogSize is how many finished journeys a newly opened page receives.
const backlogSize = 300

// App is the state shared by the capture side and the HTTP side.
type App struct {
	// token is the secret every API request must carry. It is empty when the
	// check is off (--dangerously-skip-token).
	token string

	group int
	// packetView tells whether the bytes of the traced packets are kept and served.
	packetView bool
	skipPorts  []int
	lostFn     func() uint64
	sockets    *SocketTable

	mu      sync.Mutex
	filter  Filter
	ruleset string
	backlog []*Journey
	host    HostState
	hostKey string
	subs    map[chan []byte]bool
}

type message struct {
	Type string `json:"type"`
	Data any    `json:"data"`
}

type hello struct {
	Host   string    `json:"host"`
	Hooks  []Hook    `json:"hooks"`
	State  HostState `json:"state"`
	Filter Filter    `json:"filter"`
	// PacketView tells the page whether it can ask for the bytes of a packet.
	PacketView bool       `json:"packetView"`
	Journeys   []*Journey `json:"journeys"`
}

func encode(typ string, data any) []byte {
	b, _ := json.Marshal(message{typ, data})
	return b
}

// broadcast sends a message to all open pages. A page that cannot keep up is
// disconnected and reloads the backlog when it reconnects. The caller holds a.mu.
func (a *App) broadcast(msg []byte) {
	for ch := range a.subs {
		select {
		case ch <- msg:
		default:
			delete(a.subs, ch)
			close(ch)
		}
	}
}

// RefreshHost reloads the interfaces and the sockets and tells the open pages
// when they changed.
func (a *App) RefreshHost() {
	if err := a.sockets.Refresh(); err != nil {
		return
	}
	st := a.sockets.Snapshot()
	key, _ := json.Marshal(st)
	a.mu.Lock()
	defer a.mu.Unlock()
	if string(key) == a.hostKey {
		return
	}
	a.host, a.hostKey = st, string(key)
	a.broadcast(encode("host", st))
}

// OnJourney stores a finished journey and pushes it to the open pages.
func (a *App) OnJourney(j *Journey) {
	a.mu.Lock()
	keep := a.filter.Keeps(j)
	a.mu.Unlock()
	if !keep {
		return
	}
	a.sockets.ResolveOwners(j)
	a.mu.Lock()
	defer a.mu.Unlock()
	a.backlog = append(a.backlog, j)
	if len(a.backlog) > backlogSize {
		a.backlog = a.backlog[len(a.backlog)-backlogSize:]
	}
	a.broadcast(encode("journey", j))
}

// SetFilter validates the filter and reinstalls the probes for it.
func (a *App) SetFilter(f Filter) error {
	if err := f.Normalize(); err != nil {
		return err
	}
	ruleset := Ruleset(f, a.group, a.skipPorts)
	if err := InstallProbes(ruleset); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ruleset != "" && a.ruleset != ruleset {
		// The packets traced so far belong to the previous filter.
		a.backlog = nil
		a.broadcast(encode("clear", nil))
	}
	a.filter, a.ruleset = f, ruleset
	a.broadcast(encode("filter", f))
	return nil
}

func (a *App) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming is not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")

	host, _ := os.Hostname()
	ch := make(chan []byte, 1024)
	a.mu.Lock()
	first := encode("hello", hello{Host: host, Hooks: Hooks, State: a.host, Filter: a.filter, PacketView: a.packetView, Journeys: a.backlog})
	a.subs[ch] = true
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		if a.subs[ch] {
			delete(a.subs, ch)
		}
		a.mu.Unlock()
	}()

	send := func(msg []byte) {
		fmt.Fprintf(w, "data: %s\n\n", msg)
		fl.Flush()
	}
	send(first)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			send(msg)
		case <-tick.C:
			send(encode("stats", map[string]uint64{"lost": a.lostFn()}))
		}
	}
}

// allowChange guards the endpoints that change something. It rejects requests
// that another website could make a visitor's browser send (CSRF): such requests
// cannot carry a JSON content type without a CORS preflight, which pathviz never
// approves, and browsers label them as cross-site.
func allowChange(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "use POST", http.StatusMethodNotAllowed)
		return false
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		http.Error(w, "use Content-Type: application/json", http.StatusUnsupportedMediaType)
		return false
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		http.Error(w, "cross-site requests are not allowed", http.StatusForbidden)
		return false
	}
	return true
}

func (a *App) handleFilter(w http.ResponseWriter, r *http.Request) {
	if !allowChange(w, r) {
		return
	}
	var f Filter
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&f); err != nil {
		http.Error(w, "bad filter: "+err.Error(), http.StatusBadRequest)
		return
	}
	if err := a.SetFilter(f); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleClear(w http.ResponseWriter, r *http.Request) {
	if !allowChange(w, r) {
		return
	}
	a.mu.Lock()
	a.backlog = nil
	a.broadcast(encode("clear", nil))
	a.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleRuleset(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, a.ruleset)
}

// packetHop is a packet as one probe saw it, split into layers and fields.
type packetHop struct {
	Hook  string `json:"hook"`
	Stage string `json:"stage"`
	Exit  bool   `json:"exit,omitempty"`
	Dissection
}

// handlePacket returns the bytes of a traced packet at every hop.
func (a *App) handlePacket(w http.ResponseWriter, r *http.Request) {
	if !a.packetView {
		http.Error(w, "the packet view is disabled (--no-packet-view)", http.StatusForbidden)
		return
	}
	id, err := strconv.ParseUint(r.URL.Query().Get("id"), 10, 64)
	if err != nil {
		http.Error(w, "bad packet id", http.StatusBadRequest)
		return
	}
	var j *Journey
	a.mu.Lock()
	for _, item := range a.backlog {
		if item.ID == id {
			j = item
			break
		}
	}
	a.mu.Unlock()
	if j == nil {
		http.Error(w, "the packet is not kept anymore", http.StatusNotFound)
		return
	}
	// A finished journey does not change, so it is read without the lock.
	hops := make([]packetHop, 0, len(j.Hops))
	for i, hop := range j.Hops {
		if i >= len(j.raw) {
			break
		}
		hops = append(hops, packetHop{Hook: hop.Hook, Stage: hop.Stage, Exit: hop.Exit, Dissection: Dissect(j.raw[i])})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(map[string]any{"id": j.ID, "hops": hops})
}

// tokenMatches compares a value with the access token in constant time.
func (a *App) tokenMatches(got string) bool {
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(a.token)) == 1
}

// authorized tells whether the request carries the access token: in the
// Authorization header, or in the URL for an EventSource, which cannot set
// headers. A cookie is not accepted, and PathViz never sets one: a browser
// sends the cookies of a host to every port of it, so any other web server of
// the machine that the browser visits would get the token.
func (a *App) authorized(r *http.Request) bool {
	if a.token == "" {
		return true
	}
	if bearer, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer "); ok && a.tokenMatches(bearer) {
		return true
	}
	return a.tokenMatches(r.URL.Query().Get("token"))
}

// Handler returns the HTTP handler of the UI and its API. The files of the
// page hold no secrets and are open to everyone. The API is not: without the
// token the page can neither see a packet nor change anything.
func (a *App) Handler() http.Handler {
	api := http.NewServeMux()
	api.HandleFunc("/api/events", a.handleEvents)
	api.HandleFunc("/api/filter", a.handleFilter)
	api.HandleFunc("/api/clear", a.handleClear)
	api.HandleFunc("/api/ruleset", a.handleRuleset)
	api.HandleFunc("/api/packet", a.handlePacket)
	// The page asks this one whether its token is right.
	api.HandleFunc("/api/session", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) })

	static, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(static))
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// The address of the page can hold the token: it must not leak to other sites.
		w.Header().Set("Referrer-Policy", "no-referrer")
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if !a.authorized(r) {
			http.Error(w, "the access token is missing or wrong", http.StatusUnauthorized)
			return
		}
		api.ServeHTTP(w, r)
	})
	return mux
}
