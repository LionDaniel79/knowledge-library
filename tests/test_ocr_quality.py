import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from pdf_ocr_quality import tile_boxes, merge_lines, filter_body, repeated_margins, reading_order, deskew, result_lines, recognize_body, header_probe_pages
from unittest.mock import patch
from PIL import Image, ImageDraw

def line(text,x,y,w=300,h=25):
    return {'text':text,'box':[x,y,w,h]}

class QualityTests(unittest.TestCase):
    def test_header_samples_stay_in_the_current_section_and_include_both_page_parities(self):
        self.assertEqual(header_probe_pages(174,30),[8,9,16,17,24,25])
        self.assertEqual(header_probe_pages(174,100),[104,105,112,113,120,121])
        self.assertEqual(header_probe_pages(3,2),[1,2,3])

    def test_slash_folios_in_anthology_headers_are_removed_without_stripping_chapter_numbers(self):
        pages=[[line(f'Author · 제2장 사회법 / {n}',80,30,500,20)]for n in (81,82,83)]
        result=filter_body(pages[0],1000,1000,repeated_margins(pages,1000))
        self.assertEqual(result['lines'],[])
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

    def test_normal_prose_mentioning_sequence_is_not_misclassified_as_contents(self):
        for text in ('이들은 차례로 일어나 이렇게 말했습니다.', '두 차례의 세계대전', '차례대로 써 보내는 것이 좋은 줄 알았노니', '목차를 살펴보면 이 주장을 이해할 수 있다.'):
            with self.subTest(text=text):
                result=filter_body([line(text,30,200)],1000,1000,set())
                self.assertEqual(result['review'],[])
                self.assertEqual(result['lines'][0]['text'],text)
        for text in ('차례','목 차','차 례'):
            self.assertTrue(filter_body([line(text,30,200)],1000,1000,set())['review'])

    def test_same_words_in_larger_chapter_title_are_not_running_header(self):
        header=line('Chapter One',400,20,200,12)
        repeated=repeated_margins([[header],[line('Chapter One',402,22,201,13)],[header]],1000)
        title=line('Chapter One',150,65,700,40)
        body=filter_body([header,title],1000,1000,repeated)
        self.assertEqual(body['lines'],[title])
        self.assertEqual(body['removed'],[header])

    def test_folios_joined_to_alternating_headers_are_removed_by_geometry(self):
        pages=[]
        for n in range(20,26):
            text=f'{n} 어떻게 기도할까?' if n%2==0 else f'{n} How To Pray'
            pages.append([line(text,80,25,500,20),line(f'{n} | 기도의 능력',80,950,320,20)])
        repeated=repeated_margins(pages,1000)
        title=line('어떻게 기도할까?',80,75,750,40)
        footnote=line('1. 기도의 근거를 설명하는 각주',80,930,600,20)
        result=filter_body(pages[0]+[title,footnote],1000,1000,repeated)
        self.assertEqual(result['lines'],[title,footnote])
        self.assertEqual(result['removed'],pages[0])

    def test_chapter_numbers_are_not_generalized_into_same_running_title(self):
        pages=[[line(f'제{n}장 인간 이해',80,30,400,25)] for n in range(1,7)]
        repeated=repeated_margins(pages,1000)
        self.assertFalse(repeated)

    def test_bottom_running_title_with_chapter_number_and_folio_is_not_a_footnote(self):
        pages=[[line(f'7. 새벽의 기도 | {n}',300,905,250,16)] for n in (77,79,81)]
        repeated=repeated_margins(pages,1000)
        note=line('7. 각주의 출처와 설명',80,905,500,16)
        result=filter_body(pages[0]+[note],1000,1000,repeated)
        self.assertEqual(result['lines'],[note])

    def test_separate_footnote_number_beside_text_is_not_page_number(self):
        marker=line('1',80,950,12,12)
        text=line('Footnote text',100,950,600,12)
        page_number=line('215',480,990,30,12)
        body=filter_body([marker,text,page_number],1000,1000,set())
        self.assertEqual(body['lines'],[marker,text])
        self.assertEqual(body['removed'],[page_number])

    def recognize_tiled(self,results):
        image=Image.new('L',(2480,3508),255)
        calls=iter([{'lines':[],'textAngle':0}]+results)
        try:
            with patch('pdf_ocr_quality.deskew',side_effect=lambda im:(im.copy(),0)):
                return recognize_body(image,lambda _:next(calls))
        finally:image.close()

    def test_clipped_tile_footnote_keeps_complete_neighbor_once(self):
        result=self.recognize_tiled([
            {'lines':[line('footnote sentence',80,1804,600,30)]},
            {'lines':[line('The complete footnote sentence',40,130,1000,30)]},
        ])
        self.assertEqual(result['text'],'The complete footnote sentence')
        self.assertEqual(result['review'],[])

    def test_conflicting_tile_recognition_requires_review(self):
        result=self.recognize_tiled([
            {'lines':[line('different footnote',80,1804,600,30)]},
            {'lines':[line('The complete footnote sentence',40,130,1000,30)]},
        ])
        self.assertTrue(result['review'])

    def test_rotation_in_final_tile_keeps_margin_and_requires_review(self):
        result=self.recognize_tiled([
            {'lines':[line('12',1200,5,30,20)],'textAngle':3},
            {'lines':[],'textAngle':0},
        ])
        self.assertIn('12',result['text'])
        self.assertTrue(result['review'])

    def test_lost_roman_section_heading_requires_review_even_when_text_length_is_similar(self):
        image=Image.new('L',(1000,1000),255)
        try:
            with patch('pdf_ocr_quality.deskew',side_effect=lambda im:(im.copy(),0)):
                result=recognize_body(image,lambda _:{'lines':[line('본문 문장과 각주 내용',80,200)]},old_text='본문 문장과\nⅦ\n각주 내용')
            self.assertTrue(result['review'])
        finally:image.close()

    def test_installed_language_and_region_review_propagate_to_page_evidence(self):
        image=Image.new('L',(1000,1000),255)
        try:
            result=recognize_body(image,lambda _:{'lines':[line('본문과 English reference',80,200)],'language':'ko+en-US','review':['영문 인용 검수'],'languageEdits':[{'original':'old','recognized':'new','language':'en-US','box':[1,2,3,4]}]})
            self.assertEqual(result['language'],'ko+en-US');self.assertIn('영문 인용 검수',result['review'])
            self.assertNotIn('box',result['languageEdits'][0]);self.assertIn('stage',result['languageEdits'][0])
        finally:image.close()

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
        result={'lines':[{'text':'왼쪽 본문 오른쪽 본문','box':[20,y,900,25],'words':[{'text':'왼쪽','box':[20,y,100,25]},{'text':'본문','box':[130,y,100,25]},{'text':'오른쪽','box':[600,y,100,25]},{'text':'본문','box':[710,y,100,25]}]} for y in (100,160,220)]}
        self.assertEqual([l['text'] for l in result_lines(result)],['왼쪽 본문','오른쪽 본문']*3)

    def test_bibliographic_gap_is_not_treated_as_a_two_column_gutter(self):
        result={'lines':[{'text':'55. Author H. (ed.) Title','box':[203,1763,676,23],'words':[{'text':'55.','box':[203,1765,48,19]},{'text':'Author','box':[257,1766,80,20]},{'text':'H.','box':[365,1766,18,18]},{'text':'(ed.)','box':[482,1763,41,22]},{'text':'Title','box':[531,1766,53,19]}]}]}
        self.assertEqual([l['text'] for l in result_lines(result)],['55. Author H. (ed.) Title'])

if __name__=='__main__':unittest.main()
