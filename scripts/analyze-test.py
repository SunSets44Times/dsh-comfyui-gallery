import unittest
from analyze import group, fingerprint
from PIL import Image, ImageDraw

class GroupingTests(unittest.TestCase):
    def test_anchor_prevents_chain(self):
        records = [{'id': str(i), 'hash': f'{h:016x}', 'ratio': 1} for i,h in enumerate([0,7,63])]
        result = group(records, 'phash', 'strict')
        self.assertEqual([m['id'] for m in result[0]['members']], ['0','1'])
        self.assertEqual(len(result), 1)
    def test_aspect_ratio_guard(self):
        self.assertEqual(group([{'id':'a','hash':'0','ratio':1}, {'id':'b','hash':'0','ratio':2}], 'phash', 'loose'), [])
    def test_empty_input(self):
        self.assertEqual(group([], 'semantic', 'normal'), [])
        self.assertEqual(group([], 'phash', 'normal'), [])
    def test_fingerprint_resize(self):
        im = Image.new('RGB',(320,240),'white'); draw = ImageDraw.Draw(im); draw.rectangle((20,60,180,180),fill='black'); draw.ellipse((200,10,300,110),fill='gray')
        self.assertLessEqual((int(fingerprint(im),16)^int(fingerprint(im.resize((640,480))),16)).bit_count(), 3)
    def test_semantic_anchor(self):
        import numpy as np, base64
        vectors = [[127,0], [123,32], [100,78]]
        records = [{'id':str(i),'vector':base64.b64encode(np.array(v,dtype=np.int8).tobytes()).decode()} for i,v in enumerate(vectors)]
        result = group(records,'semantic','strict')
        self.assertEqual([m['id'] for m in result[0]['members']], ['0','1'])

if __name__ == '__main__':
    unittest.main()
