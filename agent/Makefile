.PHONY: build linux-amd64 linux-arm64 darwin-arm64 windows-amd64 clean

APP := yaws-agent
PKG := ./cmd/yaws-agent
BIN_DIR := bin
VERSION ?= dev
COMMIT ?= $(shell git rev-parse --short=8 HEAD 2>/dev/null || echo "")
LDFLAGS := -s -w -X main.Version=$(VERSION) -X main.Commit=$(COMMIT)

build:
	mkdir -p $(BIN_DIR)
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(APP) $(PKG)

linux-amd64:
	mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(APP)-linux-amd64 $(PKG)

linux-arm64:
	mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(APP)-linux-arm64 $(PKG)

darwin-arm64:
	mkdir -p $(BIN_DIR)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(APP)-darwin-arm64 $(PKG)

windows-amd64:
	mkdir -p $(BIN_DIR)
	GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(APP)-windows-amd64.exe $(PKG)

clean:
	rm -rf $(BIN_DIR)
