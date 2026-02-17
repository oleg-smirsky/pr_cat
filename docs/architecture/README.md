# Architecture Guide

This document is the canonical map of runtime layers and allowed dependencies.

## Layer Map

### 1) HTTP and UI boundary

- Scope: `app/*` and `components/*`
- Responsibilities: parse request/query params, call application services/ports, return typed responses.

### 2) Application and domain

- Scope: `lib/core/*`
- Responsibilities: domain entities and value objects, service contracts (ports), authentication middleware, and dependency injection container.

### 3) Infrastructure adapters

- Scope: `lib/infrastructure/*`
- Responsibilities: implement ports against Turso, GitHub, and demo mode adapters with environment-based wiring.

### 4) Legacy data/service layer (migration in progress)

- Scope: `lib/services/*` and `lib/repositories/*`
- Responsibilities: older service/repository implementations used by some routes.

## Preferred path for new code

For new API behavior:

1. Add or extend a port in `lib/core/ports/*` if needed.
2. Implement/extend adapter(s) in `lib/infrastructure/adapters/*`.
3. Consume services from `ServiceLocator` in route handlers.
4. Keep route handlers thin and focused on transport concerns.

## Source of truth

- Machine-readable manifest: [`docs/architecture/repository-manifest.json`](./repository-manifest.json)
- Boundary rules: [`docs/architecture/dependency-rules.json`](./dependency-rules.json)
