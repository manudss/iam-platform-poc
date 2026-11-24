import copy
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('contract', Path(__file__).with_name('delivery-contract.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class DeliveryVerdict(unittest.TestCase):
    def setUp(self):
        self.sha = 'a' * 40
        self.digest = 'sha256:' + 'b' * 64
        self.jobs = {j: {'result': 'success'} for j in c.JOBS}
        self.receipts = [{'format': 1, 'scenario': s, 'passed': True, 'sha': self.sha,
                          'digest': self.digest, 'checks': {k: True for k in c.CHECKS[s]},
                          'evidence': {'actual-run': 'c' * 64}} for s in c.SCENARIOS]

    def passed(self):
        return c.aggregate(self.jobs, self.receipts, self.sha, self.digest)['passed']

    def test_complete_exact_candidate(self):
        self.assertTrue(self.passed())

    def test_every_non_success_is_red(self):
        for job in c.JOBS:
            for state in ['skipped', 'cancelled', 'failure', 'timed_out', '', None]:
                with self.subTest(job=job, state=state):
                    jobs = copy.deepcopy(self.jobs)
                    jobs[job]['result'] = state
                    self.assertFalse(c.aggregate(jobs, self.receipts, self.sha, self.digest)['passed'])

    def test_missing_and_extra_jobs(self):
        for job in c.JOBS:
            jobs = copy.deepcopy(self.jobs)
            del jobs[job]
            self.assertFalse(c.aggregate(jobs, self.receipts, self.sha, self.digest)['passed'])
        self.jobs['unexpected'] = {'result': 'success'}
        self.assertFalse(self.passed())

    def test_missing_duplicate_extra_receipts(self):
        for receipts in [[], self.receipts[:1], self.receipts * 2, [self.receipts[0]] * 2]:
            self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest)['passed'])

    def test_other_image_or_sha_is_red(self):
        for key in ['sha', 'digest']:
            receipts = copy.deepcopy(self.receipts)
            receipts[0][key] = 'wrong'
            self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest)['passed'])

    def test_no_final_probe_can_be_ignored(self):
        for i, receipt in enumerate(self.receipts):
            for check in receipt['checks']:
                receipts = copy.deepcopy(self.receipts)
                receipts[i]['checks'][check] = False
                self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest)['passed'])

    def test_missing_evidence_or_check(self):
        for field in ['evidence', 'checks']:
            receipts = copy.deepcopy(self.receipts)
            receipts[1][field] = {}
            self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest)['passed'])

    def test_truthy_is_not_true(self):
        self.receipts[1]['passed'] = 'true'
        self.assertFalse(self.passed())


if __name__ == '__main__':
    unittest.main()
