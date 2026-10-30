/** Fixed, single-use MCP stdio bridge inside the Claude sandbox. The supervisor owns its mount and lifetime. */
export const CLAUDE_MCP_FIFO_PYTHON = String.raw`
import errno, fcntl, os, select, stat, sys, time

if len(sys.argv) != 1:
    raise ValueError('MCP_FIFO_UNAVAILABLE')

def refuse():
    raise ValueError('MCP_FIFO_UNAVAILABLE')

def checked(fd, kind, mode):
    item = os.fstat(fd)
    if item.st_uid != os.getuid() or stat.S_IMODE(item.st_mode) != mode or not kind(item.st_mode):
        refuse()

directory = os.open('/relay', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
checked(directory, stat.S_ISDIR, 0o700)
lock = os.open('helper.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
checked(lock, stat.S_ISREG, 0o600)
item = os.fstat(lock)
if item.st_nlink != 1 or item.st_size != 1:
    refuse()
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
if os.pread(lock, 2, 0) != b'0':
    refuse()
if os.pwrite(lock, b'1', 0) != 1:
    refuse()
os.fsync(lock)

incoming = os.open('in', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
checked(incoming, stat.S_ISFIFO, 0o600)
probe = os.open('out', os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
checked(probe, stat.S_ISFIFO, 0o600)
os.close(probe)

startup_end = time.monotonic() + 5
while True:
    try:
        outgoing = os.open('out', os.O_WRONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                           dir_fd=directory)
        checked(outgoing, stat.S_ISFIFO, 0o600)
        break
    except OSError as error:
        if error.errno != errno.ENXIO or time.monotonic() >= startup_end:
            raise
        time.sleep(.01)

os.set_blocking(0, False)
os.set_blocking(1, False)
to_fifo = bytearray()
to_stdout = bytearray()
stdin_eof = False
outgoing_closed = False
inbound_connected = False
inbound_eof = False
inbound_startup_end = time.monotonic() + 5
drain_end = None
fifo_pending_since = None
stdout_pending_since = None
limit = 262144

try:
    while True:
        now = time.monotonic()
        if not inbound_connected and len(to_stdout) < limit:
            try:
                initial = os.read(incoming, min(65536, limit - len(to_stdout)))
            except BlockingIOError:
                inbound_connected = True
            else:
                if initial:
                    inbound_connected = True
                    stdout_pending_since = now
                    to_stdout.extend(initial)
        if not inbound_connected and drain_end is None and now >= inbound_startup_end:
            raise TimeoutError('MCP_FIFO_STARTUP')
        if drain_end is not None and now >= drain_end:
            if to_fifo or to_stdout:
                raise TimeoutError('MCP_FIFO_DRAIN')
            break
        if stdin_eof and not to_fifo and not outgoing_closed:
            os.close(outgoing)
            outgoing_closed = True
        if to_fifo and fifo_pending_since is not None and now - fifo_pending_since >= 5:
            raise TimeoutError('MCP_FIFO_BACKPRESSURE')
        if to_stdout and stdout_pending_since is not None and now - stdout_pending_since >= 5:
            raise TimeoutError('MCP_STDOUT_BACKPRESSURE')
        readers = []
        writers = []
        if not stdin_eof and len(to_fifo) < limit:
            readers.append(0)
        if inbound_connected and not inbound_eof and len(to_stdout) < limit:
            readers.append(incoming)
        if to_fifo and not outgoing_closed:
            writers.append(outgoing)
        if to_stdout:
            writers.append(1)
        timeout = .02 if drain_end is None else max(0, min(.02, drain_end - now))
        ready_read, ready_write, _ = select.select(readers, writers, [], timeout)
        if 0 in ready_read:
            try:
                chunk = os.read(0, min(65536, limit - len(to_fifo)))
            except BlockingIOError:
                chunk = None
            if chunk == b'':
                stdin_eof = True
                if drain_end is None:
                    drain_end = time.monotonic() + 1
            elif chunk:
                if not to_fifo:
                    fifo_pending_since = time.monotonic()
                to_fifo.extend(chunk)
        if incoming in ready_read:
            try:
                chunk = os.read(incoming, min(65536, limit - len(to_stdout)))
            except BlockingIOError:
                chunk = None
                inbound_connected = True
            if chunk:
                inbound_connected = True
                if not to_stdout:
                    stdout_pending_since = time.monotonic()
                to_stdout.extend(chunk)
            elif chunk == b'' and inbound_connected:
                inbound_eof = True
                if drain_end is None:
                    drain_end = time.monotonic() + 1
        if outgoing in ready_write and to_fifo:
            try:
                written = os.write(outgoing, to_fifo)
            except BlockingIOError:
                written = 0
            if written:
                del to_fifo[:written]
                fifo_pending_since = time.monotonic() if to_fifo else None
        if 1 in ready_write and to_stdout:
            try:
                written = os.write(1, to_stdout)
            except BlockingIOError:
                written = 0
            if written:
                del to_stdout[:written]
                stdout_pending_since = time.monotonic() if to_stdout else None
finally:
    if not outgoing_closed:
        os.close(outgoing)
    os.close(incoming)
    os.close(lock)
    os.close(directory)
`;
