import importlib.util
import unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('receipt',Path(__file__).with_name('delivery-receipt.py'))
r=importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RealProducerReceipt(unittest.TestCase):
    def setUp(self):
        self.lines=['state=CLOSED_QUALIFIED','held=true']+[k+'='+'a'*64 for k in sorted(r.HELPERS)]*2

    def validate(self,lines):
        return r.validate_actual_receipt(('\n'.join(lines)+'\n').encode())

    def test_actual_concatenated_helpers(self):
        self.assertEqual(self.validate(self.lines)['held'],'true')

    def test_actual_incident_consumer_accepts_same_bytes(self):
        path=Path(__file__).resolve().parents[1]/'deploy/oci/reviewed-ui-held.py'
        if not path.is_file():self.skipTest('incident consumer is not in this source tree')
        spec=importlib.util.spec_from_file_location('incident_receipt_consumer',path)
        consumer=importlib.util.module_from_spec(spec);spec.loader.exec_module(consumer)
        raw=('\n'.join(self.lines)+'\n').encode()
        self.assertEqual(consumer.receipt_fields(raw),r.validate_actual_receipt(raw))
        integration=Path(__file__).with_name('delivery-docker-integration.py').read_text()
        self.assertIn('parser.receipt_fields(receipt.read_bytes())',integration)

    def test_other_duplicate_is_refused(self):
        with self.assertRaises(ValueError):self.validate(self.lines+['held=true'])

    def test_each_conflicting_helper_is_refused(self):
        for helper in r.HELPERS:
            lines=self.lines.copy();lines[lines.index(helper+'='+'a'*64)]=helper+'='+'b'*64
            with self.subTest(helper=helper),self.assertRaises(ValueError):self.validate(lines)

    def test_missing_single_and_third_occurrence_are_refused(self):
        for helper in r.HELPERS:
            for count in [0,1,3]:
                lines=[x for x in self.lines if not x.startswith(helper+'=')]+[helper+'='+'a'*64]*count
                with self.subTest(helper=helper,count=count),self.assertRaises(ValueError):self.validate(lines)

    def test_malformed_helper_or_wire_line_is_refused(self):
        for value in ['A'*64,'a'*63,'not-a-hash']:
            lines=[x.replace('a'*64,value) for x in self.lines]
            with self.assertRaises(ValueError):self.validate(lines)
        with self.assertRaises(ValueError):self.validate(self.lines+['not-a-key-value'])


if __name__=='__main__':unittest.main()
