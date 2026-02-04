//go:build !linux

package main

import "fmt"

type cpuSampler struct{}

func newCPUSampler() *cpuSampler { return &cpuSampler{} }

func (c *cpuSampler) Usage() (float64, error) {
	return 0, fmt.Errorf("unsupported OS")
}

func readMem() (used int64, total int64, err error) {
	return 0, 0, fmt.Errorf("unsupported OS")
}

func readDisk(_ string) (used int64, total int64, err error) {
	return 0, 0, fmt.Errorf("unsupported OS")
}

func readNet() (rxBytes, txBytes int64, err error) {
	return 0, 0, fmt.Errorf("unsupported OS")
}

func readLoad() (l1, l5, l15 float64, err error) {
	return 0, 0, 0, fmt.Errorf("unsupported OS")
}

func readConnCounts() (tcp int64, udp int64, err error) {
	return 0, 0, fmt.Errorf("unsupported OS")
}
