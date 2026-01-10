//go:build !linux

package main

import "runtime"

type sysInfo struct {
	OSName        string
	OSVersion     string
	Arch          string
	KernelVersion string
	CPUModel      string
	CPUCores      int
}

func getSysInfo() sysInfo {
	return sysInfo{
		OSName:    runtime.GOOS,
		Arch:      runtime.GOARCH,
		CPUCores:  runtime.NumCPU(),
		CPUModel:  "",
		OSVersion: "",
	}
}
