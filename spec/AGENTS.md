# spec

## Structure

```
spec/
├── features/                    # Gherkin specs
└── step_defs/                   # Step definitions
```

## Test Levels

- **backend/**: Connect directly to the server over Socket.IO and HTTP. No browser required
- **frontend/**: Playwright drives the SPA served by a real server. Apple Music traffic goes through the MusicKit API mock; the game is driven through the console, the action page, and the action API, and verified on the console, gameboard, and action pages
- **integration/**: Full sessions across the console, gameboard, and action buttons, run by the frontend step definitions

All tests are E2E. A test observes only what a host, player, or audience member can observe. It never reads the server's state over the socket, never sends console events over the socket, and never depends on the shape of the server's state. The server's state model is an implementation detail; when it changes, a test breaks only if the screens change.
