import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from pdf_ocr_quality import tile_boxes, merge_lines, filter_body, repeated_margins, reading_order, deskew, result_lines
from PIL import Image, ImageDraw

def line(text,x,y,w=300,h=25):
    return {'text':text,'box':[x,y,w,h]}

class QualityTests(unittest.TestCase):
    def test_tiles_cover_large_pages_without_downscaling_and_have_bounded_overlap(self):
        boxes=tile_boxes(2480,3508,2400,160)
        self.assertTrue(all(x1-x0<=2400 and y1-y0<=2400 for x0,y0,x1,y1 in boxes))
        self.assertTrue(any(y1==3508 for x0,y0,x1,y1 in boxes))
        self.assertTrue(any(x1==2480 for x0,y0,x1,y1 in boxes))
        self.assertLessEqual(len(boxes),4)

    def test_overlap_duplicate_removed_but_repeated_body_words_are_preserved(self):
        result=merge_lines([line('같은 문장',40,100),line('같은 문장',42,102),line('같은 문장',40,160)])
        self.assertEqual(len(result),2)

    def test_repeated_headers_removed_but_chapter_title_and_footnote_preserved(self):
        pages=[[line('제1장 인간 이해',80,30),line('본문',80,200),line('각주 1. 상담의 근거',80,930),line(str(n),480,990,30,18)] for n in range(1,5)]
        repeated=repeated_margins(pages,1000)
        body=filter_body(pages[0]+[line('새로운 장 제목',80,100)],1000,1000,repeated)
        texts=[l['text'] for l in body['lines']]
        self.assertNotIn('제1장 인간 이해',texts)
        self.assertNotIn('1',texts)
        self.assertIn('각주 1. 상담의 근거',texts)
        self.assertIn('새로운 장 제목',texts)

    def test_unknown_advertisement_is_held_for_review_not_erased(self):
        result=filter_body([line('신간 안내 구매 문의 www.example.com',30,200)],1000,1000,set())
        self.assertTrue(result['review'])
        self.assertTrue(result['lines'])

    def test_columns_preserve_spanning_heading_and_bottom_footnote(self):
        lines=[line('장 제목',10,10,900),line('왼쪽 첫째',10,100,400),line('오른쪽 첫째',570,100,400),line('왼쪽 둘째',10,160,400),line('오른쪽 둘째',570,160,400),line('왼쪽 셋째',10,220,400),line('오른쪽 셋째',570,220,400),line('각주',10,800,900)]
        self.assertEqual([l['text'] for l in reading_order(lines,1000)],['장 제목','왼쪽 첫째','왼쪽 둘째','왼쪽 셋째','오른쪽 첫째','오른쪽 둘째','오른쪽 셋째','각주'])

    def test_deskew_estimates_nonzero_rotation_without_losing_canvas(self):
        image=Image.new('L',(800,1000),255);draw=ImageDraw.Draw(image)
        for y in range(120,880,45):draw.rectangle((60,y,740,y+8),fill=30)
        tilted=image.rotate(2,resample=Image.Resampling.BICUBIC,expand=True,fillcolor=255)
        result,angle=deskew(tilted)
        self.assertAlmostEqual(angle,-2,delta=.5)
        self.assertGreaterEqual(result.height,tilted.height)
        result.close();tilted.close();image.close()

    def test_joined_columns_split_at_word_gutter_without_losing_words(self):
        result={'lines':[{'text':'왼쪽 본문 오른쪽 본문','box':[20,100,900,25],'words':[{'text':'왼쪽','box':[20,100,100,25]},{'text':'본문','box':[130,100,100,25]},{'text':'오른쪽','box':[600,100,100,25]},{'text':'본문','box':[710,100,100,25]}]}]}
        self.assertEqual([l['text'] for l in result_lines(result)],['왼쪽 본문','오른쪽 본문'])

if __name__=='__main__':unittest.main()
