# features

Gherkin feature files — the single source of truth for specs.

## Structure

```
features/
├── backend/
├── frontend/
└── integration/
```

## Feature File Writing Rules

- **Scenarios**: Testable behavior only. Every scenario must be verifiable against a running system by what its surfaces show.
- **Steps name what a person does or sees**: `the host gives up`, `the console shows the stage "解答ステップ"`, `the gameboard shows player "player-1" with 1 point`, `action button "player-1" receives no reaction`.
- Screen labels appear verbatim in Japanese, as the person sees them.

### Content policy

Feature specs describe behavior only. Do not include:

- Library names/versions (e.g., Fuse.js, threshold 0.4)
- API calls/method names (e.g., mk.play(), mk.seekToTime(0))
- Internal state names/data structure paths (e.g., `state.answererId`, `phase`, `step`)
- Source file references
- Server internal state management (e.g., "the backend marks the answerer"). Describe observable checks and outcomes, not how the server tracks them
- Visual appearance (colors, fonts, sizes, spacing, layout, styling)

**Exception**: HTTP endpoints and status codes of the action API are allowed; they are the interface of a physical button.

### Robustness

An expression is fragile if a change elsewhere would make it incorrect or incomplete. Prefer what stays true as the spec evolves: "the console shows the stage ..." over an internal step name, "the selected playlists are ..." over an id list.
