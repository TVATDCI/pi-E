/* minidc-peercred-helper.c — kernel peer-credential probe for the R2 broker (spec
 * §2.2 / R4: SO_PEERCRED is the sole accepted source of connector identity).
 *
 * R2 design v2 (r2-design-spec-sol-draft-2026-11-24): claim verification binds to
 * the kernel-attested live peer pid+uid. Node v26.13.1 exposes no SO_PEERCRED API
 * (probed again this round; D1a's finding stands), so the daemon passes each
 * accepted connection fd to this helper at handshake time and reads the kernel's
 * answer from its stdout. getsockopt(SO_PEERCRED) reports the credentials the
 * kernel recorded for the peer at connect() time — connect-time-frozen, unaffected
 * by later pid reuse — which is exactly the property the spec's identity law
 * needs.
 *
 * Exit codes: 0 = printed {"pid":N,"uid":N,"gid":N}; 1 = fd is not a connected
 * unix socket (or getsockopt refused); 2 = usage. The daemon treats every non-0
 * answer as "no kernel identity" and fails the presenter path closed.
 *
 * usage: minidc-peercred-helper [FD]   (FD defaults to 0 — the passed socket)
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc > 2) { fprintf(stderr, "usage: %s [FD]\n", argv[0]); return 2; }
    int fd = (argc == 2) ? atoi(argv[1]) : 0;
    if (fd < 0) { fprintf(stderr, "bad fd\n"); return 2; }

    struct stat st;
    if (fstat(fd, &st) != 0) { fprintf(stderr, "fstat: %s\n", strerror(errno)); return 1; }
    if (!S_ISSOCK(st.st_mode)) { fprintf(stderr, "fd %d is not a socket\n", fd); return 1; }

    struct ucred cred;
    socklen_t len = sizeof(cred);
    memset(&cred, 0, sizeof(cred));
    if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len) != 0) {
        fprintf(stderr, "getsockopt(SO_PEERCRED): %s\n", strerror(errno));
        return 1;
    }
    printf("{\"pid\":%u,\"uid\":%u,\"gid\":%u}\n", cred.pid, cred.uid, cred.gid);
    return 0;
}
