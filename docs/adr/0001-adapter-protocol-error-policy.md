# ADR-0001: Handle Invalid Adapter Frames by Transport Ownership

**Status**: Accepted
**Date**: 2026-08-19

## Context

Eventa beta.14 introduced the `EventaInner` adapter envelope. A beta.13 peer can
send the older `id`/`type`/`payload` envelope. The shared adapter boundary now
accepts that envelope and writes both shapes for every adapter.

An actually invalid frame can still arrive repeatedly. Several adapters wrote a
console error for every rejected frame. A reconnecting WebSocket peer caused an
error storm in production.

## Decision

The adapter boundary accepts supported legacy envelopes before it classifies a
frame as invalid.

WebSocket adapters own one peer connection. They report the first invalid frame,
abort that peer context, and close the peer with code `4002`.

Other adapters do not always own an isolatable peer. They keep the transport
usable and emit their existing adapter error event for every invalid frame. Each
adapter context writes its diagnostic parse error to the console once.

Unix sockets keep their framing policy. Invalid JSON destroys the socket. A
valid JSON frame with an invalid Eventa envelope emits `unixSocketErrorEvent`.

## Consequences

Applications keep per-frame error events for monitoring and recovery. The
Eventa library no longer floods diagnostic output from one persistent bad peer.

Connection-oriented transports can end an incompatible connection. Shared or
local transports do not terminate an unrelated sender or channel.
