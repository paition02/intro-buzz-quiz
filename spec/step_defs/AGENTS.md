# step_defs

pytest-bdd step definitions. Feature files live in `../features/{scope}/`. Each test module names the feature files it implements.

## Structure

```
step_defs/
├── conftest.py                  # Server URL, artwork server, HTTP client
├── quiz_transport.py            # Socket client for backend tests only
├── backend/                     # Socket.IO / HTTP scenarios against the server
└── frontend/
    ├── conftest.py              # Playwright browser, page fixture, console-driven reset
    ├── helpers.py               # Screen-level helpers: console stage, round info, gameboard players and scores
    ├── musickit_mock.py         # MusicKit API mock arrangements (test data)
    ├── playback_observer.js     # Media observation and SDK fault injection in the page
    ├── controlled_*.ts          # Controlled boundaries for the ordering tests
    └── test_*.py
```

## Execution Context

All tests are E2E. The application server is started externally (`TEST_BACKEND_URL`) before running tests; tests do not start or manage it. Real-time waits are the correct approach for time-dependent behavior; test-only time manipulation is prohibited.

## Observation Rules (Frontend Tests)

Verify the observable consequences of the game, never its internal state:

- **Driver**: the host acts on the console page; players act through the action page or `POST /api/act/:actorId`; the audience watches the gameboard. Do not emit console events over the socket.
- **Oracle**: the console's stage heading, status text, round information (曲情報 / アルバム情報) and controls; the gameboard's stage, participants, answerer and scores; the action API's status code. Do not read the socket `state` event. "Server internal state" is not an excuse — verify what the screens show.
- **Expected values** come from the test data (`musickit_mock.py`: song `track-N` is "Track N" by "Artist N" on "Album N") and from what a screen showed earlier in the scenario, never from the server.
- **Isolation**: every scenario starts by resetting the game from a console page (`reset_game` in `frontend/conftest.py`), the way a host does.
- **Media**: MusicKit playback state is read from the real SDK in the page (`playback_observer.js`); physical audio output is not verified.

## Step Definition Rules

Every step definition must perform an action or verify a condition. `pass` is never acceptable:

- **Given**: Establish the precondition, or verify it was established by a preceding step
- **When**: Perform the action, or verify the action occurred
- **Then**: Assert the expected outcome

## Element Selection (Frontend Tests)

Use Playwright's role-based locators (`get_by_role`, `get_by_label`, `get_by_text`) to select elements. Do not use CSS selectors that guess implementation details.

## Commands

Run from `spec/step_defs`: `uv run pytest` (or `bun run test` from the repository root). Set `TEST_BACKEND_URL` to a dedicated test server; never point tests at the server used for playing.
