# Library Layer Guide

This folder contains both current and legacy runtime logic.

## Preferred architecture

- `lib/core/*`: domain model, ports, auth middleware, dependency container.
- `lib/infrastructure/*`: adapter implementations selected by environment.

## Legacy architecture (migration in progress)

- `lib/services/*`: legacy business services.
- `lib/repositories/*`: legacy repository functions.

## Guidance

- New behavior should be designed through core ports and infrastructure adapters.
- Legacy folders should mostly receive bug fixes and compatibility updates.
- If you must add logic in legacy folders, leave migration context in the PR description.

