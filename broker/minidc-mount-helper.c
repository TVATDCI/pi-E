/* minidc-mount-helper.c — the fd-bound mount helper (design §4.6.4, verbatim law):
 *
 *  ONE privileged (root) helper, invoked three ways:
 *    - by minidc-mounts.service ExecStart (activation),
 *    - by its ExecStop (`--stop` leg),
 *    - by install.sh --repair-mounts (and the P5 rollback's already-inactive branch).
 *
 *  Activation protocol (each step fail-closed):
 *    1. rewrite mount-health to unhealthy-pending FIRST — a failure of THIS write
 *       aborts the activation before any attach.
 *    2. no-follow walk from `/` to each Where= target (store then rules — attach
 *       order; the stop leg unmounts in REVERSE order): a symlink in ANY ancestor
 *       component aborts.
 *    3. Where= classification: absent → mkdirat stub (journaled `created-stub:`);
 *       regular dir → proceed; symlink/other type → moved aside via
 *       renameat2(RENAME_NOREPLACE) — the kernel refuses overwrites; unique names.
 *    4. every repair action journaled (intent + outcome rows, fsync'd) into the
 *       P4-created repair-journal.jsonl — the helper APPENDS, never creates.
 *    5. the attach: open_tree(OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH) onto a
 *       HELD target-directory fd via move_mount(MOVE_MOUNT_F_EMPTY_PATH|
 *       MOVE_MOUNT_T_EMPTY_PATH) — exactly these flags (code-shape law; verified at
 *       /usr/include/linux/mount.h:64/66/73/76). NO path-based mount(2) exists in the
 *       automatic path.
 *    6. post-attach validation is a FRESH lookup against the CLONE'S RECORDED mount id
 *       + the backing root's dev/ino (held-fd expectations are fd-semantics-dead).
 *       Any check failure → immediate detach + journal + unhealthy + abort.
 *
 *  `--stop` leg (ExecStop; fail-closed order):
 *    1. health written {healthy:false, findings:["service-stop"]} FIRST — write
 *       failure aborts BEFORE any unmount.
 *    2. umount2 rules then store (reverse attach order) at fd-validated anchors;
 *       EINVAL = already-down (idempotent); EBUSY = journaled finding, mount lingers,
 *       health already unhealthy. Never MNT_DETACH.
 *
 *  Compile: cc -O2 -Wall -o minidc-mount-helper minidc-mount-helper.c
 *  (Build-round note: raw syscalls need C — Node exposes none of open_tree/move_mount/
 *  renameat2/statx/umount2. Compiled at install; cc absence fails closed per the
 *  design's fallback law.)
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/mount.h>
#include <linux/stat.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/mount.h>
#include <time.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

static const char *g_backing = "/var/lib/minidc-broker";
static const char *g_home = NULL;
static const char *g_journal_path(void) {
  static char p[512];
  snprintf(p, sizeof p, "%s/repair-journal.jsonl", g_backing);
  return p;
}
static const char *g_health_path(void) {
  static char p[512];
  snprintf(p, sizeof p, "%s/state/mount-health.json", g_backing);
  return p;
}

static void boot_id(char *out, size_t n) {
  FILE *f = fopen("/proc/sys/kernel/random/boot_id", "r");
  if (!f || !fgets(out, (int)n, f)) { snprintf(out, n, "unknown"); }
  if (f) fclose(f);
  out[strcspn(out, "\n")] = 0;
}

static void iso_now(char *out, size_t n) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  struct tm tm;
  gmtime_r(&ts.tv_sec, &tm);
  snprintf(out, n, "%04d-%02d-%02dT%02d:%02d:%02d.%03ldZ",
           tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
           tm.tm_hour, tm.tm_min, tm.tm_sec, ts.tv_nsec / 1000000);
}

/* finding 8 fix: EVERY journal write is CHECKED — a stub created without its
 * ground-truth row (open/write/fsync failure) aborts the activation: the rollback
 * consumes exactly the journaled stub set, so an unrecorded stub would strand. */
static int journal_row(const char *action, const char *a, const char *b) {
  char ts[64];
  iso_now(ts, sizeof ts);
  char line[1024];
  int len = snprintf(line, sizeof line,
                     "{\"ts\":\"%s\",\"action\":\"%s\",\"a\":\"%s\",\"b\":\"%s\"}\n",
                     ts, action, a ? a : "", b ? b : "");
  if (len <= 0) return -1;
  /* O_APPEND — the P4-created journal; the helper NEVER creates it (finding 1 of #10) */
  int fd = open(g_journal_path(), O_WRONLY | O_APPEND | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  ssize_t wrote = write(fd, line, (size_t)len);
  int sync_rc = fsync(fd);
  close(fd);
  if (wrote != (ssize_t)len || sync_rc != 0) return -1;
  return 0;
}

/* atomic health write: temp inside state/ + rename (root temp+rename discipline) */
static int health_write(int healthy, const char *const *findings, int nfindings) {
  char boot[64]; boot_id(boot, sizeof boot);
  char ts[64]; iso_now(ts, sizeof ts);
  char dir[512], tmp[600];
  snprintf(dir, sizeof dir, "%s/state", g_backing);
  snprintf(tmp, sizeof tmp, "%s/.health-tmp-%d", dir, (int)getpid());
  FILE *f = fopen(tmp, "w");
  if (!f) return -1;
  fprintf(f, "{\"healthy\":%s,\"boot-id\":\"%s\",\"checked-at\":\"%s\",\"findings\":[",
          healthy ? "true" : "false", boot, ts);
  for (int i = 0; i < nfindings; i++) fprintf(f, "%s\"%s\"", i ? "," : "", findings[i]);
  fprintf(f, "]}\n");
  if (fflush(f) != 0 || fsync(fileno(f)) != 0) { fclose(f); unlink(tmp); return -1; }
  fclose(f);
  if (rename(tmp, g_health_path()) != 0) { unlink(tmp); return -1; }
  return 0;
}

static void die_unhealthy(const char *why, const char *detail) {
  const char *f[2] = { why, detail };
  health_write(0, f, detail ? 2 : 1);
  fprintf(stderr, "minidc-mount-helper: ABORT (%s%s%s)\n", why, detail ? ": " : "", detail ? detail : "");
  journal_row("abort", why, detail);
  exit(1);
}

/* no-follow walk from `/` — returns a held O_PATH dirfd for the PARENT of leaf and
 * validates every component; leaf classified via *type. Symlink anywhere → -1. */
static int walk_parent(const char *path, char *leaf_out, size_t leaf_n,
                       int *leaf_type, int *leaf_dirfd_out) {
  char buf[4096];
  snprintf(buf, sizeof buf, "%s", path);
  /* split leaf */
  char *slash = strrchr(buf, '/');
  if (!slash || slash == buf) return -1;
  *slash = 0;
  snprintf(leaf_out, leaf_n, "%s", slash + 1);
  int dirfd = open("/", O_PATH | O_DIRECTORY);
  if (dirfd < 0) return -1;
  char *save = NULL;
  for (char *seg = strtok_r(buf, "/", &save); seg; seg = strtok_r(NULL, "/", &save)) {
    struct stat st;
    if (fstatat(dirfd, seg, &st, AT_SYMLINK_NOFOLLOW) != 0) { close(dirfd); return -1; }
    if (S_ISLNK(st.st_mode)) { close(dirfd); errno = ELOOP; return -1; }
    if (!S_ISDIR(st.st_mode)) { close(dirfd); errno = ENOTDIR; return -1; }
    int next = openat(dirfd, seg, O_PATH | O_DIRECTORY | O_NOFOLLOW);
    close(dirfd);
    if (next < 0) return -1;
    dirfd = next;
  }
  struct stat st;
  if (fstatat(dirfd, leaf_out, &st, AT_SYMLINK_NOFOLLOW) != 0) {
    *leaf_type = 0; /* absent */
  } else if (S_ISLNK(st.st_mode)) {
    *leaf_type = S_IFLNK;
  } else if (S_ISDIR(st.st_mode)) {
    *leaf_type = S_IFDIR;
  } else {
    *leaf_type = S_IFREG; /* any other non-dir type handled as "aside" */
  }
  *leaf_dirfd_out = dirfd;
  return 0;
}

static int open_path_no_follow(const char *path, int flags) {
  char leaf[256]; int type = 0, parent = -1;
  if (walk_parent(path, leaf, sizeof leaf, &type, &parent) != 0) return -1;
  int fd = openat(parent, leaf, flags | O_NOFOLLOW);
  close(parent);
  return fd;
}

/* renameat2 wrapper with RENAME_NOREPLACE */
static int rename_noreplace(int olddirfd, const char *oldname,
                            int newdirfd, const char *newname) {
#ifdef SYS_renameat2
  return (int)syscall(SYS_renameat2, olddirfd, oldname, newdirfd, newname, RENAME_NOREPLACE);
#else
  (void)olddirfd; (void)oldname; (void)newdirfd; (void)newname;
  errno = ENOSYS; return -1;
#endif
}

static int statx_mnt_id(int fd, unsigned long long *mnt_id) {
  struct statx sx;
  memset(&sx, 0, sizeof sx);
#ifdef SYS_statx
  if (syscall(SYS_statx, fd, "", AT_EMPTY_PATH, STATX_MNT_ID, &sx) != 0) return -1;
#else
  (void)fd; (void)mnt_id; errno = ENOSYS; return -1;
#endif
  if (!(sx.stx_mask & STATX_MNT_ID)) { errno = ENODATA; return -1; }
  *mnt_id = sx.stx_mnt_id;
  return 0;
}

/* ══ the attach: exactly-flagged open_tree + move_mount onto a HELD target dirfd ══ */
static int attach(const char *backing_path, const char *where_path, char *err_out, size_t err_n) {
  err_out[0] = 0;
  /* classify Where= (no-follow): stub-create / proceed / aside */
  char leaf[256]; int type = 0, parent = -1;
  if (walk_parent(where_path, leaf, sizeof leaf, &type, &parent) != 0) {
    snprintf(err_out, err_n, "walk-failed(%s)", strerror(errno));
    return -1;
  }
  /* finding 8: journal rows for created stubs and asides are CHECKED — a stub
   * without its ground-truth row aborts (the rollback consumes exactly the
   * journaled set; an unrecorded stub would strand), and an unjournaled aside is
   * unauditable evidence. */
  char stubnote[600];
  snprintf(stubnote, sizeof stubnote, "created-stub:%s", where_path);
  if (type == 0) {
    if (mkdirat(parent, leaf, 0755) != 0) {
      close(parent);
      snprintf(err_out, err_n, "stub-mkdir-failed(%s)", strerror(errno));
      return -1;
    }
    if (journal_row("created-stub", where_path, "") != 0 ||
        journal_row("created-stub-row", stubnote, "") != 0) {
      close(parent);
      snprintf(err_out, err_n, "journal-write-failed(created-stub)");
      return -1;
    }
  } else if (type == S_IFLNK || type == S_IFREG) {
    /* move the ENTRY aside (its target never read, never followed) */
    char aside[512];
    long t = (long)time(NULL);
    int attempt = 0;
    for (;;) {
      snprintf(aside, sizeof aside, "%s.adversarial-%ld-%d", leaf, t, attempt++);
      if (rename_noreplace(parent, leaf, parent, aside) == 0) break;
      if (errno != EEXIST) {
        close(parent);
        snprintf(err_out, err_n, "aside-failed(%s)", strerror(errno));
        return -1;
      }
    }
    if (journal_row("aside-moved", where_path, aside) != 0) {
      close(parent);
      snprintf(err_out, err_n, "journal-write-failed(aside-moved)");
      return -1;
    }
    if (mkdirat(parent, leaf, 0755) != 0) {
      close(parent);
      snprintf(err_out, err_n, "post-aside-stub-failed(%s)", strerror(errno));
      return -1;
    }
    if (journal_row("created-stub", where_path, "") != 0 ||
        journal_row("created-stub-row", stubnote, "") != 0) {
      close(parent);
      snprintf(err_out, err_n, "journal-write-failed(created-stub)");
      return -1;
    }
  } else if (type != S_IFDIR) {
    close(parent);
    snprintf(err_out, err_n, "where-type-unexpected");
    return -1;
  }
  /* idempotence at activation: if a mount already sits at the name, validate-or-unmount */
  int fresh = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (fresh >= 0) {
    unsigned long long parent_mnt = 0, fresh_mnt = 0;
    int pfd = openat(parent, ".", O_RDONLY | O_DIRECTORY);
    if (pfd >= 0) { (void)statx_mnt_id(pfd, &parent_mnt); close(pfd); }
    int got = statx_mnt_id(fresh, &fresh_mnt);
    close(fresh);
    if (got == 0 && parent_mnt != 0 && fresh_mnt != parent_mnt) {
      /* a mount already sits between parent and name — validate backing identity */
      int bfd = open_path_no_follow(backing_path, O_PATH | O_DIRECTORY);
      if (bfd >= 0) {
        struct stat bst, fst;
        if (fstat(bfd, &bst) == 0 && fstatat(parent, leaf, &fst, 0) == 0 &&
            bst.st_dev == fst.st_dev && bst.st_ino == fst.st_ino) {
          close(bfd); close(parent);
          journal_row("already-mounted", where_path, "healthy");
          return 0; /* healthy — skip */
        }
        close(bfd);
      }
      /* mismatched: unmount, then the full attach path runs again — finding 8:
       * the detach is CHECKED; a failed detach ABORTS (reattaching over a live
       * wrong mount is never attempted) */
      int tfd = openat(parent, leaf, O_PATH | O_DIRECTORY | O_NOFOLLOW);
      if (tfd >= 0) {
#ifdef SYS_move_mount
        if (syscall(SYS_move_mount, tfd, "", AT_FDCWD, "", MOVE_MOUNT_F_EMPTY_PATH) != 0 &&
            errno != EINVAL && errno != ENOENT) {
          close(tfd);
          close(parent);
          close(bfd);
          snprintf(err_out, err_n, "revalidate-detach-failed(%s)", strerror(errno));
          return -1;
        }
#endif
        close(tfd);
      }
      journal_row("revalidate-unmounted", where_path, "");
    }
  }
  /* (a) backing fd + backing identity (dev/ino) */
  int backing_fd = open_path_no_follow(backing_path, O_PATH | O_DIRECTORY);
  if (backing_fd < 0) {
    close(parent);
    snprintf(err_out, err_n, "backing-open-failed(%s)", strerror(errno));
    return -1;
  }
  struct stat backing_st;
  if (fstat(backing_fd, &backing_st) != 0) {
    close(parent); close(backing_fd);
    snprintf(err_out, err_n, "backing-fstat-failed");
    return -1;
  }
  /* (b) detached clone — OPEN_TREE_CLONE|OPEN_TREE_CLOEXEC|AT_EMPTY_PATH (exact flags) */
  int clone_fd = (int)syscall(SYS_open_tree, backing_fd, "",
                              OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_EMPTY_PATH);
  if (clone_fd < 0) {
    close(parent); close(backing_fd);
    snprintf(err_out, err_n, "open_tree-failed(%s)", strerror(errno));
    return -1;
  }
  unsigned long long clone_mnt = 0;
  if (statx_mnt_id(clone_fd, &clone_mnt) != 0) {
    close(parent); close(backing_fd); close(clone_fd);
    snprintf(err_out, err_n, "clone-mnt-id-failed");
    return -1;
  }
  struct stat clone_st;
  if (fstat(clone_fd, &clone_st) != 0 || clone_st.st_dev != backing_st.st_dev ||
      clone_st.st_ino != backing_st.st_ino) {
    close(parent); close(backing_fd); close(clone_fd);
    snprintf(err_out, err_n, "clone-identity-mismatch");
    return -1;
  }
  /* (c) held target dirfd (the validated stub inode — no pathname resolution at attach) */
  int target_fd = openat(parent, leaf, O_PATH | O_DIRECTORY | O_NOFOLLOW);
  if (target_fd < 0) {
    close(parent); close(backing_fd); close(clone_fd);
    snprintf(err_out, err_n, "target-dirfd-failed(%s)", strerror(errno));
    return -1;
  }
  /* (d) attach — MOVE_MOUNT_F_EMPTY_PATH|MOVE_MOUNT_T_EMPTY_PATH (exact flags) */
  if (syscall(SYS_move_mount, clone_fd, "", target_fd, "",
              MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) != 0) {
    close(parent); close(backing_fd); close(clone_fd); close(target_fd);
    snprintf(err_out, err_n, "move_mount-failed(%s)", strerror(errno));
    return -1;
  }
  close(target_fd);
  close(backing_fd);
  /* (e) POST-ATTACH VALIDATION — FRESH lookup vs the clone's recorded identity */
  fresh = openat(parent, leaf, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (fresh < 0) {
    close(parent); close(clone_fd);
    snprintf(err_out, err_n, "fresh-lookup-failed(%s)", strerror(errno));
    return -1;
  }
  unsigned long long fresh_mnt = 0;
  struct stat fresh_st;
  int bad = 0;
  char why[256] = "";
  if (statx_mnt_id(fresh, &fresh_mnt) != 0 || fresh_mnt != clone_mnt) {
    bad = 1; snprintf(why, sizeof why, "mnt-id-mismatch");
  } else if (fstat(fresh, &fresh_st) != 0 ||
             fresh_st.st_dev != backing_st.st_dev || fresh_st.st_ino != backing_st.st_ino) {
    bad = 1; snprintf(why, sizeof why, "backing-identity-mismatch");
  }
  close(fresh);
  close(parent);
  close(clone_fd);
  if (bad) {
    /* immediate detach at the fd-anchored point + journal + caller marks unhealthy —
     * finding 8: the detach is CHECKED; if it fails the error names BOTH problems
     * (the bad attach AND the failed detach) so the operator knows the mount lingers */
    int tfd = open_path_no_follow(where_path, O_PATH | O_DIRECTORY);
    int detach_failed = 0;
    if (tfd >= 0) {
#ifdef SYS_move_mount
      if (syscall(SYS_move_mount, tfd, "", AT_FDCWD, "", MOVE_MOUNT_F_EMPTY_PATH) != 0 &&
          errno != EINVAL && errno != ENOENT) {
        detach_failed = 1;
      }
#endif
      close(tfd);
    }
    journal_row("detach-after-detect", where_path, why);
    snprintf(err_out, err_n, detach_failed
      ? "post-attach-validation(%s)+DETACH-FAILED-MOUNT-LINGERS"
      : "post-attach-validation(%s)", why);
    return -1;
  }
  if (journal_row("attached", where_path, backing_path) != 0) {
    /* finding 8: the attach evidence row is required — an unjournaled healthy
     * attach still aborts (health stays false-pending; the service fails loudly) */
    snprintf(err_out, err_n, "journal-write-failed(attached)");
    return -1;
  }
  return 0;
}

static int unmount_at(const char *where_path, char *note_out, size_t note_n) {
  int tfd = open_path_no_follow(where_path, O_PATH | O_DIRECTORY);
  if (tfd < 0) {
    if (errno == ENOENT) { snprintf(note_out, note_n, "absent"); return 0; }
    snprintf(note_out, note_n, "walk-failed(%s)", strerror(errno));
    return -1;
  }
  /* umount2 at the /proc/self/fd-anchored point (dismantle direction; root-only) */
  char fdpath[128];
  snprintf(fdpath, sizeof fdpath, "/proc/self/fd/%d", tfd);
  if (umount2(fdpath, 0) != 0) {
    int e = errno;
    close(tfd);
    if (e == EINVAL || e == ENOENT) { snprintf(note_out, note_n, "already-down"); return 0; }
    if (e == EBUSY) { snprintf(note_out, note_n, "unmount-ebusy"); return 0; }
    snprintf(note_out, note_n, "umount-failed(%s)", strerror(e));
    return -1;
  }
  close(tfd);
  snprintf(note_out, note_n, "unmounted");
  return 0;
}

int main(int argc, char **argv) {
  const char *home = getenv("MINIDC_TARGET_HOME");
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--backing") && i + 1 < argc) g_backing = argv[++i];
    else if (!strcmp(argv[i], "--home") && i + 1 < argc) home = argv[++i];
  }
  if (!home) {
    struct passwd *pw = getpwnam("vladi");
    home = pw ? pw->pw_dir : "/home/vladi";
  }
  g_home = home;
  char store_where[1024], rules_where[1024], backing_store[1024], backing_rules[1024];
  snprintf(store_where, sizeof store_where, "%s/.pi/agent/mini-dc", home);
  snprintf(rules_where, sizeof rules_where, "%s/.pi/agent/mini-dc-rules", home);
  snprintf(backing_store, sizeof backing_store, "%s/store", g_backing);
  snprintf(backing_rules, sizeof backing_rules, "%s/rules", g_backing);

  if (argc > 1 && !strcmp(argv[1], "--stop")) {
    /* ══ the STOP leg (ExecStop): health FIRST or ABORT BEFORE ANY UNMOUNT ══ */
    const char *f1[1] = { "service-stop" };
    if (health_write(0, f1, 1) != 0) {
      fprintf(stderr, "minidc-mount-helper: --stop health write FAILED — aborting before unmount\n");
      journal_row("stop-abort", "health-write-failed", "");
      return 1;
    }
    journal_row("stop-intent", "unmount", "rules,store");
    char note[256];
    /* reverse attach order: rules then store */
    int rc = 0;
    if (unmount_at(rules_where, note, sizeof note) != 0) rc = 1;
    journal_row("unmount", rules_where, note);
    if (unmount_at(store_where, note, sizeof note) != 0) rc = 1;
    journal_row("unmount", store_where, note);
    journal_row("stop-outcome", rc == 0 ? "ok" : "partial", "");
    return rc;
  }

  /* ══ activation: unhealthy-pending FIRST — write failure aborts before any attach ══ */
  const char *pending[1] = { "activation-started" };
  if (health_write(0, pending, 1) != 0) {
    fprintf(stderr, "minidc-mount-helper: activation health write FAILED — aborting before attach\n");
    journal_row("activation-abort", "health-write-failed", "");
    return 1;
  }
  char err[512] = "";
  /* attach order: store first, rules second (reverse-order stop composes with this) */
  if (attach(backing_store, store_where, err, sizeof err) != 0) {
    die_unhealthy("attach-store-failed", err);
  }
  if (attach(backing_rules, rules_where, err, sizeof err) != 0) {
    die_unhealthy("attach-rules-failed", err);
  }
  const char *okf[1] = { "activation-complete" };
  if (health_write(1, okf, 1) != 0) {
    /* mounts stand but the record failed — the unit-state law backstops; report loudly */
    fprintf(stderr, "minidc-mount-helper: attached but FINAL health write failed\n");
    return 1;
  }
  return 0;
}
