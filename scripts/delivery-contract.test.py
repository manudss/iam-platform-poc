import copy
import importlib.util
import unittest
import tempfile
import subprocess
import json
import hashlib
from pathlib import Path

spec = importlib.util.spec_from_file_location('contract', Path(__file__).with_name('delivery-contract.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class DeliveryVerdict(unittest.TestCase):
    def setUp(self):
        self.sha = 'a' * 40
        self.digest = 'sha256:' + 'b' * 64
        self.parent = 'c' * 40
        self.base_digest = 'sha256:' + 'd' * 64
        self.jobs = {j: {'result': 'success'} for j in c.JOBS}
        self.receipts = [{'format': 1, 'scenario': s, 'passed': True, 'sha': self.sha,
                          'digest': self.digest, 'checks': {k: True for k in c.CHECKS[s]},
                          'baselineSha': self.parent, 'baselineDigest': self.base_digest,
                          'evidence': {'actual-run': 'c' * 64}} for s in c.SCENARIOS]

    def passed(self):
        return c.aggregate(self.jobs, self.receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed']

    def test_complete_exact_candidate(self):
        self.assertTrue(self.passed())

    def test_every_non_success_is_red(self):
        for job in c.JOBS:
            for state in ['skipped', 'cancelled', 'failure', 'timed_out', '', None]:
                with self.subTest(job=job, state=state):
                    jobs = copy.deepcopy(self.jobs)
                    jobs[job]['result'] = state
                    self.assertFalse(c.aggregate(jobs, self.receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed'])

    def test_missing_and_extra_jobs(self):
        for job in c.JOBS:
            jobs = copy.deepcopy(self.jobs)
            del jobs[job]
            self.assertFalse(c.aggregate(jobs, self.receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed'])
        self.jobs['unexpected'] = {'result': 'success'}
        self.assertFalse(self.passed())

    def test_missing_duplicate_extra_receipts(self):
        for receipts in [[], self.receipts[:1], self.receipts * 2, [self.receipts[0]] * 2]:
            self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed'])

    def test_other_image_or_sha_is_red(self):
        for key in ['sha', 'digest']:
            receipts = copy.deepcopy(self.receipts)
            receipts[0][key] = 'wrong'
            self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed'])

    def test_no_final_probe_can_be_ignored(self):
        for i, receipt in enumerate(self.receipts):
            for check in receipt['checks']:
                receipts = copy.deepcopy(self.receipts)
                receipts[i]['checks'][check] = False
                self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed'])

    def test_missing_evidence_or_check(self):
        for field in ['evidence', 'checks']:
            receipts = copy.deepcopy(self.receipts)
            receipts[1][field] = {}
            self.assertFalse(c.aggregate(self.jobs, receipts, self.sha, self.digest, self.parent, self.parent, self.base_digest)['passed'])


    def test_uploaded_bytes_are_rehashed(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            for receipt in self.receipts:
                folder=root/receipt['scenario'];folder.mkdir()
                item=folder/'candidate-script-hashes.json';item.write_text('real proof')
                receipt['evidence']={item.name:hashlib.sha256(item.read_bytes()).hexdigest()}
                if receipt['scenario']=='fresh':
                    (folder/'ui').mkdir()
                    for name in ['browser-proof.json','desktop-login.png','mobile-login.png','desktop-authenticated.png','mobile-authenticated.png']:
                        browser=folder/'ui'/name;browser.write_bytes(b'fixture-bytes')
                        receipt['evidence']['ui/'+name]=hashlib.sha256(browser.read_bytes()).hexdigest()
                (folder/'delivery-receipt.json').write_text(json.dumps(receipt))
            needs=root/'needs.json';needs.write_text(json.dumps(self.jobs))
            args=['python3',str(Path(__file__).with_name('delivery-contract.py')),'--needs',str(needs),'--receipts',str(root),'--sha',self.sha,'--digest',self.digest,'--parent-sha',self.parent,'--baseline-sha',self.parent,'--baseline-digest',self.base_digest,'--out',str(root/'verdict.json')]
            self.assertEqual(subprocess.run(args,capture_output=True).returncode,0)
            (root/'upgrade/candidate-script-hashes.json').write_text('changed bytes')
            self.assertNotEqual(subprocess.run(args,capture_output=True).returncode,0)

    def test_baseline_identity_mutations(self):
        for key in ['baselineSha','baselineDigest']:
            receipts=copy.deepcopy(self.receipts);receipts[1][key]='wrong'
            self.assertFalse(c.aggregate(self.jobs,receipts,self.sha,self.digest,self.parent,self.parent,self.base_digest)['passed'])
        self.assertFalse(c.aggregate(self.jobs,self.receipts,self.sha,self.digest,'e'*40,self.parent,self.base_digest)['passed'])
        self.assertFalse(c.aggregate(self.jobs,self.receipts,self.sha,self.digest,self.parent,self.parent,'sha256:'+'e'*64)['passed'])

    def test_truthy_is_not_true(self):
        self.receipts[1]['passed'] = 'true'
        self.assertFalse(self.passed())


class HeldQueueFixture(unittest.TestCase):
    def test_actual_format3_refusals_do_not_mutate_state_or_run_updater(self):
        source=Path(__file__).resolve().parents[1]
        spec=importlib.util.spec_from_file_location('delivery_fixture',source/'scripts/delivery-docker-integration.py')
        fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
        queue=fixture.load_module(source/'deploy/oci/ordered-queue.py','held_fixture_queue')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);base='a'*40;digest='sha256:'+'b'*64
            state={'format':2,'history':[{'sha':base,'digest':digest}], 'recovery_fence':base,'resume_required':True,'recoveries':[{'target':{'sha':base}}]}
            plan={'format':1,'base':base,'entries':[{'sha':'c'*40,'parent':base,'digest':'sha256:'+'d'*64}]}
            fixture.verify_held_queue_refusals(queue,root,source/'deploy/oci',state,plan,root/'never-updater')
            self.assertEqual(json.loads((root/'held-queue.json').read_text())['history'][-1]['sha'],base)

if __name__ == '__main__':
    unittest.main()
