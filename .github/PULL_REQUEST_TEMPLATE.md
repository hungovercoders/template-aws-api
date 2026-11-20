## What and why

<!-- What changes for whoever calls the API, and the issue it closes. -->

Closes #

## Checks

- [ ] The spec changed first: scenarios in `specs/features` and the contract say what this does
- [ ] `task spec:compat` passes; a breaking change is a new major's file beside the old, and consumers know
- [ ] `task ci` is green
- [ ] No skeleton file changed - or `task skeleton:lock` is in this change and I can say why the skeleton had to move
- [ ] No gate was weakened

<!-- template-only:start - removed by `task adopt` when a repository becomes an API -->
## For a change to the template itself

- [ ] Made on `main`, not on an example branch; the `template` check is green (`ci` on `main` is red by design)
- [ ] After merging: merged down `main` → `example/spec` → `example/implementation`, and `example/implementation` is green
<!-- template-only:end -->
