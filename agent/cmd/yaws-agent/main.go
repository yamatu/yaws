package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"time"

	"github.com/gorilla/websocket"
)

type helloMsg struct {
	Type      string `json:"type"`
	MachineID int    `json:"machineId"`
	Key       string `json:"key"`
	Hostname  string `json:"hostname,omitempty"`
	OSName    string `json:"osName,omitempty"`
	OSVersion string `json:"osVersion,omitempty"`
	Arch      string `json:"arch,omitempty"`
	Kernel    string `json:"kernelVersion,omitempty"`
	CPUModel  string `json:"cpuModel,omitempty"`
	CPUCores  int    `json:"cpuCores,omitempty"`
}

type metricsMsg struct {
	Type string `json:"type"`
	At   int64  `json:"at,omitempty"`
	CPU  struct {
		Usage float64 `json:"usage"`
	} `json:"cpu"`
	Mem struct {
		Used  int64 `json:"used"`
		Total int64 `json:"total"`
	} `json:"mem"`
	Disk struct {
		Used  int64 `json:"used"`
		Total int64 `json:"total"`
	} `json:"disk"`
	Net struct {
		RxBytes int64 `json:"rxBytes"`
		TxBytes int64 `json:"txBytes"`
	} `json:"net,omitempty"`
	Conn *struct {
		TCP int64 `json:"tcp"`
		UDP int64 `json:"udp"`
	} `json:"conn,omitempty"`
	Load struct {
		L1  float64 `json:"l1"`
		L5  float64 `json:"l5"`
		L15 float64 `json:"l15"`
	} `json:"load,omitempty"`
}

type helloOkMsg struct {
	Type        string `json:"type"`
	MachineID   int    `json:"machineId"`
	IntervalSec int    `json:"intervalSec"`
}

var (
	Version = "dev"
	Commit  = ""
)

func main() {
	var configPath string
	var wsURL string
	var machineID int
	var key string
	var interval time.Duration
	var diskPath string
	var showVersion bool

	flag.StringVar(&configPath, "config", "", "path to agent config json (download from controller)")
	flag.StringVar(&wsURL, "url", "", "ws url, e.g. ws://host:3001/ws/agent")
	flag.IntVar(&machineID, "id", 0, "machine id from controller")
	flag.StringVar(&key, "key", "", "agent key from controller (keep secret)")
	flag.DurationVar(&interval, "interval", 5*time.Second, "metrics interval (server may override)")
	flag.StringVar(&diskPath, "disk", "/", "disk path to measure, default /")
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Parse()

	if showVersion {
		fmt.Println(Version)
		return
	}

	if configPath != "" {
		cfg, err := readConfig(configPath)
		if err != nil {
			log.Printf("read config failed: %v", err)
			os.Exit(2)
		}
		if wsURL == "" {
			wsURL = cfg.URL
		}
		if machineID <= 0 {
			machineID = cfg.ID
		}
		if key == "" {
			key = cfg.Key
		}
		if diskPath == "/" && cfg.Disk != "" {
			diskPath = cfg.Disk
		}
		if interval == 5*time.Second && cfg.IntervalSec > 0 {
			interval = time.Duration(cfg.IntervalSec) * time.Second
		}
	}

	if wsURL == "" || machineID <= 0 || key == "" {
		flag.Usage()
		os.Exit(2)
	}

	if runtime.GOOS != "linux" {
		log.Printf("warning: GOOS=%s is not fully supported; metrics may fail", runtime.GOOS)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	hostname, _ := os.Hostname()
	sys := getSysInfo()

	cpu := newCPUSampler()
	backoff := 800 * time.Millisecond
	for ctx.Err() == nil {
		err := runOnce(ctx, wsURL, machineID, key, hostname, sys, interval, diskPath, cpu)
		if err == nil || ctx.Err() != nil {
			break
		}
		log.Printf("disconnected: %v; reconnecting in %s", err, backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff = minDuration(15*time.Second, backoff*2)
	}
}

func runOnce(
	ctx context.Context,
	wsURL string,
	machineID int,
	key string,
	hostname string,
	sys sysInfo,
	interval time.Duration,
	diskPath string,
	cpu *cpuSampler,
) error {
	dialer := websocket.Dialer{
		Proxy: http.ProxyFromEnvironment,
	}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))

	hello := helloMsg{
		Type:      "hello",
		MachineID: machineID,
		Key:       key,
		Hostname:  hostname,
		OSName:    sys.OSName,
		OSVersion: sys.OSVersion,
		Arch:      sys.Arch,
		Kernel:    sys.KernelVersion,
		CPUModel:  sys.CPUModel,
		CPUCores:  sys.CPUCores,
	}
	if err := conn.WriteJSON(hello); err != nil {
		return err
	}

	serverInterval := interval
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, b, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	var ok helloOkMsg
	if err := json.Unmarshal(b, &ok); err == nil && ok.Type == "hello_ok" && ok.IntervalSec >= 2 {
		serverInterval = time.Duration(ok.IntervalSec) * time.Second
	}

	// warm up CPU baseline to avoid always-0 first sample on Linux.
	_, _ = cpu.Usage()

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	ticker := time.NewTicker(serverInterval)
	defer ticker.Stop()

	readErr := make(chan error, 1)
	go func() {
		for {
			_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
			_, _, err := conn.ReadMessage()
			if err != nil {
				readErr <- err
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-readErr:
			var closeErr *websocket.CloseError
			if errors.As(err, &closeErr) {
				return fmt.Errorf("ws closed: %s", closeErr.Text)
			}
			return err
		case <-pingTicker.C:
			_ = conn.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(5*time.Second))
		case <-ticker.C:
			m, err := collectMetrics(diskPath, cpu)
			if err != nil {
				log.Printf("collect metrics failed: %v", err)
				continue
			}
			m.Type = "metrics"
			m.At = time.Now().UnixMilli()
			if err := conn.WriteJSON(m); err != nil {
				return err
			}
		}
	}
}

func collectMetrics(diskPath string, cpu *cpuSampler) (metricsMsg, error) {
	var m metricsMsg
	cpuUsage, err := cpu.Usage()
	if err != nil {
		return m, err
	}
	memUsed, memTotal, err := readMem()
	if err != nil {
		return m, err
	}
	diskUsed, diskTotal, err := readDisk(diskPath)
	if err != nil {
		return m, err
	}
	rx, tx, err := readNet()
	if err != nil {
		// optional
		rx, tx = 0, 0
	}
	l1, l5, l15, err := readLoad()
	if err != nil {
		l1, l5, l15 = 0, 0, 0
	}

	tcpConn, udpConn, err := readConnCounts()
	if err == nil {
		m.Conn = &struct {
			TCP int64 `json:"tcp"`
			UDP int64 `json:"udp"`
		}{TCP: tcpConn, UDP: udpConn}
	}

	m.CPU.Usage = clamp01(cpuUsage)
	m.Mem.Used = memUsed
	m.Mem.Total = memTotal
	m.Disk.Used = diskUsed
	m.Disk.Total = diskTotal
	m.Net.RxBytes = rx
	m.Net.TxBytes = tx
	m.Load.L1 = l1
	m.Load.L5 = l5
	m.Load.L15 = l15
	return m, nil
}

func clamp01(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

type agentConfig struct {
	URL         string `json:"url"`
	ID          int    `json:"id"`
	Key         string `json:"key"`
	Disk        string `json:"disk,omitempty"`
	IntervalSec int    `json:"intervalSec,omitempty"`
}

func readConfig(path string) (agentConfig, error) {
	var cfg agentConfig
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, err
	}
	if cfg.URL == "" || cfg.ID <= 0 || cfg.Key == "" {
		return cfg, fmt.Errorf("config missing required fields")
	}
	return cfg, nil
}
