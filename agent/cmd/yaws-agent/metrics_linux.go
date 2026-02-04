//go:build linux

package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
)

type cpuSampler struct {
	prevIdle  uint64
	prevTotal uint64
	ready     bool
}

func newCPUSampler() *cpuSampler {
	return &cpuSampler{}
}

func (c *cpuSampler) Usage() (float64, error) {
	idle, total, err := readProcStatCPU()
	if err != nil {
		return 0, err
	}
	if !c.ready {
		c.prevIdle = idle
		c.prevTotal = total
		c.ready = true
		return 0, nil
	}
	dIdle := float64(idle - c.prevIdle)
	dTotal := float64(total - c.prevTotal)
	c.prevIdle = idle
	c.prevTotal = total
	if dTotal <= 0 {
		return 0, nil
	}
	return 1 - (dIdle / dTotal), nil
}

func readProcStatCPU() (idle uint64, total uint64, err error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0, 0, fmt.Errorf("proc stat empty")
	}
	line := sc.Text()
	parts := strings.Fields(line)
	if len(parts) < 5 || parts[0] != "cpu" {
		return 0, 0, fmt.Errorf("unexpected /proc/stat format")
	}

	var nums []uint64
	for _, p := range parts[1:] {
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return 0, 0, err
		}
		nums = append(nums, n)
	}

	// idle = idle + iowait
	idle = nums[3]
	if len(nums) > 4 {
		idle += nums[4]
	}
	for _, n := range nums {
		total += n
	}
	return idle, total, nil
}

func readMem() (used int64, total int64, err error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	var memTotalKB int64
	var memAvailKB int64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			memTotalKB, _ = parseMeminfoKB(line)
		} else if strings.HasPrefix(line, "MemAvailable:") {
			memAvailKB, _ = parseMeminfoKB(line)
		}
	}
	if memTotalKB <= 0 {
		return 0, 0, fmt.Errorf("MemTotal missing")
	}
	if memAvailKB <= 0 {
		return 0, 0, fmt.Errorf("MemAvailable missing")
	}
	total = memTotalKB * 1024
	used = (memTotalKB - memAvailKB) * 1024
	if used < 0 {
		used = 0
	}
	return used, total, nil
}

func parseMeminfoKB(line string) (int64, error) {
	// e.g. "MemTotal:       16320604 kB"
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return 0, fmt.Errorf("bad meminfo line")
	}
	return strconv.ParseInt(fields[1], 10, 64)
}

func readDisk(p string) (used int64, total int64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(p, &st); err != nil {
		return 0, 0, err
	}
	// total = blocks * bsize
	total = int64(st.Blocks) * int64(st.Bsize)
	free := int64(st.Bavail) * int64(st.Bsize)
	used = total - free
	if used < 0 {
		used = 0
	}
	return used, total, nil
}

func readLoad() (l1, l5, l15 float64, err error) {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	parts := strings.Fields(string(b))
	if len(parts) < 3 {
		return 0, 0, 0, fmt.Errorf("bad /proc/loadavg")
	}
	l1, err = strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0, 0, 0, err
	}
	l5, err = strconv.ParseFloat(parts[1], 64)
	if err != nil {
		return 0, 0, 0, err
	}
	l15, err = strconv.ParseFloat(parts[2], 64)
	if err != nil {
		return 0, 0, 0, err
	}
	return l1, l5, l15, nil
}

func readNet() (rxBytes, txBytes int64, err error) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	// skip 2 header lines
	for i := 0; i < 2; i++ {
		if !sc.Scan() {
			return 0, 0, fmt.Errorf("bad /proc/net/dev")
		}
	}
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		// format: "eth0: 123 0 0 0 ... 456 0 0 ..."
		parts := strings.Fields(line)
		if len(parts) < 17 {
			continue
		}
		iface := strings.TrimSuffix(parts[0], ":")
		if iface == "lo" {
			continue
		}
		rx, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			continue
		}
		tx, err := strconv.ParseInt(parts[9], 10, 64)
		if err != nil {
			continue
		}
		rxBytes += rx
		txBytes += tx
	}
	if err := sc.Err(); err != nil {
		return 0, 0, err
	}
	return rxBytes, txBytes, nil
}

func readConnCounts() (tcp int64, udp int64, err error) {
	tcp4, err := countProcNetConns("/proc/net/tcp")
	if err != nil {
		return 0, 0, err
	}
	tcp6, err := countProcNetConns("/proc/net/tcp6")
	if err != nil {
		return 0, 0, err
	}
	udp4, err := countProcNetConns("/proc/net/udp")
	if err != nil {
		return 0, 0, err
	}
	udp6, err := countProcNetConns("/proc/net/udp6")
	if err != nil {
		return 0, 0, err
	}
	return tcp4 + tcp6, udp4 + udp6, nil
}

func countProcNetConns(filePath string) (int64, error) {
	f, err := os.Open(filePath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	// header
	if !sc.Scan() {
		return 0, nil
	}
	var n int64
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) == "" {
			continue
		}
		n++
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	return n, nil
}
