import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('b',Path(__file__).with_name('delivery-baseline.py'))
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)


class MovingBaseline(unittest.TestCase):
    def test_main_advances_and_old_baseline_refuses(self):
        with tempfile.TemporaryDirectory() as temp:
            repo=Path(temp)
            def git(*args):
                return subprocess.check_output(['git','-C',str(repo),*args],text=True,stderr=subprocess.PIPE).strip()
            git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture')
            def commit(name):
                (repo/'data').write_text(name);git('add','data');git('commit','-m',name);return git('rev-parse','HEAD')
            old=commit('base-old');candidate=commit('candidate-old')
            self.assertEqual(b.verify_baseline(repo,old,old),old)
            git('checkout','--detach',old);new=commit('base-new');candidate=commit('candidate-new')
            self.assertEqual(b.verify_baseline(repo,new,new),new)
            with self.assertRaisesRegex(ValueError,'current-first-parent'):b.verify_baseline(repo,old,old)
            with self.assertRaisesRegex(ValueError,'label-invalid'):b.verify_baseline(repo,new,old)


if __name__=='__main__':unittest.main()
