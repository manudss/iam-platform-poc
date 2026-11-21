import http.server
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'front-barrier-check.sh'


def make_handler(barrier, mode):
    """Fixture gate: 503 while the marker file exists, 200 otherwise. mode:
    'normal' keep-alive, 'close' closes the connection after each response,
    'silent' never answers HEAD (GET/POST stay normal so later phases proceed),
    'truncated' sends a valid status line then EOFs mid-headers,
    'garbage' sends a non-numeric status token."""

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def code(self):
            return 503 if barrier.exists() else 200

        def respond(self):
            self.send_response(self.code())
            self.send_header('Content-Length', '0')
            if mode == 'close':
                self.send_header('Connection', 'close')
                self.close_connection = True
            self.end_headers()

        def do_HEAD(self):
            if mode == 'silent':
                time.sleep(30)  # never answer on this connection
                return
            if mode == 'truncated':  # valid status, then EOF before the empty CRLF
                self.connection.sendall(
                    b'HTTP/1.1 %d x\r\nServer: fixture\r\n' % self.code())
                self.connection.shutdown(1)
                self.close_connection = True
                return
            if mode == 'garbage':  # status token that is not 3 digits
                self.connection.sendall(b'HTTP/1.1 BROKEN x\r\n\r\n')
                return
            self.respond()

        do_GET = respond
        do_POST = respond

        def log_message(self, *args):
            pass

    return Handler


class FrontBarrierCheck(unittest.TestCase):
    """The synchronized single-connection driver must be DETERMINISTIC: a driver-level
    failure (peer close, timeout, refused connect) is a classified DRIVER_* token in a
    loud FAIL, never a silent set -e death. The drill semantics (same connection across
    the gate, no reconnect, same assertions) are unchanged: the nominal fixture passes."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        root = Path(self.dir.name)
        self.barrier = root / 'MAINTENANCE'

    def tearDown(self):
        self.dir.cleanup()

    def serve(self, mode):
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.barrier, mode))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        return server.server_address[1]

    def run_check(self, port, timeout=90, read_timeout=None):
        env = dict(os.environ)
        env['IAM_PUBLIC_ORIGIN'] = 'http://127.0.0.1:%d' % port
        env['LYAM_FRONT_BARRIER_FILE'] = str(self.barrier)
        if read_timeout is not None:
            env['LYAM_BARRIER_READ_TIMEOUT'] = read_timeout
        return subprocess.run(['bash', str(SCRIPT)], capture_output=True, text=True,
                              env=env, timeout=timeout)

    def test_nominal_drill_passes_unchanged(self):
        result = self.run_check(self.serve('normal'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS pre-existing connection: 200 before, 503 across the gate, 200 after',
                      result.stdout)
        self.assertIn('front gate proven', result.stdout)

    def test_peer_close_is_loud_classified_fail_not_silent_death(self):
        result = self.run_check(self.serve('close'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL pre-existing connection', result.stderr)
        self.assertIn('DRIVER_', result.stderr)

    def test_unresponsive_peer_times_out_classified(self):
        result = self.run_check(self.serve('silent'), read_timeout='2')
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL pre-existing connection', result.stderr)
        self.assertIn('DRIVER_STATUS_UNREADABLE', result.stderr)

    def test_refused_connect_is_loud_fatal(self):
        result = self.run_check(1)  # port 1: nothing listens
        self.assertEqual(result.returncode, 1)
        self.assertIn('FATAL: cannot connect', result.stderr)

    def test_truncated_headers_never_a_false_pass(self):
        result = self.run_check(self.serve('truncated'), read_timeout='2')
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL pre-existing connection', result.stderr)
        self.assertIn('DRIVER_HEADERS_UNREADABLE', result.stderr)

    def test_non_numeric_status_never_interpolated(self):
        result = self.run_check(self.serve('garbage'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('FAIL pre-existing connection', result.stderr)
        self.assertIn('DRIVER_STATUS_INVALID', result.stderr)
        self.assertNotIn('BROKEN', result.stderr)


if __name__ == '__main__':
    unittest.main()
