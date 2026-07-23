"""Small cross-platform lock for crash-recoverable filesystem transactions."""

from __future__ import annotations

from contextlib import contextmanager
import errno
import os
from pathlib import Path
import stat
import threading
import time
from typing import Iterator

if os.name == "nt":
    import msvcrt
else:
    import fcntl


class FileLockError(RuntimeError):
    pass


_LOCAL_LOCKS_GUARD = threading.Lock()
_LOCAL_LOCKS: dict[str, threading.RLock] = {}
_THREAD_HELD_LOCKS = threading.local()


def _local_lock(key: str) -> threading.RLock:
    with _LOCAL_LOCKS_GUARD:
        lock = _LOCAL_LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _LOCAL_LOCKS[key] = lock
        return lock


def _lock_descriptor(descriptor: int) -> None:
    if os.name != "nt":
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        return

    # Windows byte-range locks require the range to exist. All contenders write
    # the same sentinel, then retry only errors that indicate lock contention.
    if os.fstat(descriptor).st_size < 1:
        os.lseek(descriptor, 0, os.SEEK_SET)
        os.write(descriptor, b"\0")
        os.fsync(descriptor)
    while True:
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            return
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise
            time.sleep(0.05)


def _unlock_descriptor(descriptor: int) -> None:
    if os.name != "nt":
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        return
    os.lseek(descriptor, 0, os.SEEK_SET)
    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)


def _same_regular_file(path: Path, descriptor: int) -> bool:
    descriptor_status = os.fstat(descriptor)
    path_status = os.stat(path, follow_symlinks=False)
    return bool(
        stat.S_ISREG(descriptor_status.st_mode)
        and stat.S_ISREG(path_status.st_mode)
        and (descriptor_status.st_dev, descriptor_status.st_ino)
        == (path_status.st_dev, path_status.st_ino)
    )


@contextmanager
def exclusive_file_lock(path: Path) -> Iterator[None]:
    """Hold one fixed advisory lock across instances and operating processes."""

    lock_path = Path(os.path.abspath(path))
    lock_key = str(lock_path)
    local_lock = _local_lock(lock_key)
    with local_lock:
        held_locks = getattr(_THREAD_HELD_LOCKS, "depths", None)
        if held_locks is None:
            held_locks = {}
            _THREAD_HELD_LOCKS.depths = held_locks
        nested_depth = held_locks.get(lock_key, 0)
        if nested_depth:
            held_locks[lock_key] = nested_depth + 1
            try:
                yield
            finally:
                held_locks[lock_key] -= 1
            return

        flags = os.O_RDWR | os.O_CREAT
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(lock_path, flags, 0o600)
        except OSError as exc:
            raise FileLockError(f"cannot open transaction lock: {exc}") from exc
        try:
            try:
                if not _same_regular_file(lock_path, descriptor):
                    raise FileLockError("transaction lock must be a regular file")
            except OSError as exc:
                raise FileLockError(f"cannot validate transaction lock: {exc}") from exc
            try:
                _lock_descriptor(descriptor)
            except OSError as exc:
                raise FileLockError(f"cannot acquire transaction lock: {exc}") from exc
            try:
                # Detect a lock path replaced between open and lock acquisition.
                if not _same_regular_file(lock_path, descriptor):
                    raise FileLockError("transaction lock changed while acquiring it")
                held_locks[lock_key] = 1
                try:
                    yield
                finally:
                    del held_locks[lock_key]
            finally:
                try:
                    _unlock_descriptor(descriptor)
                except OSError:
                    pass
        finally:
            os.close(descriptor)
