import io,sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from PIL import Image
from pdf_ocr import OcrEngineError
from pdf_ocr_languages import AdaptiveWindowsOcr

def image():
    im=Image.new('RGB',(800,600),'white');stream=io.BytesIO();im.save(stream,format='PNG');im.close();return stream.getvalue()

class Engine:
    def __init__(self,result):self.result=result;self.closed=False;self.calls=0
    def recognize_png(self,png):self.calls+=1;return self.result
    def close(self):self.closed=True

class LanguageTests(unittest.TestCase):
    def test_english_page_uses_installed_english_engine_and_reports_actual_language(self):
        ko=Engine({'text':'The Holy Spirit and a long English paragraph. '*5,'lines':[],'language':'ko'})
        en=Engine({'text':'Correct English source','lines':[],'language':'en-US'})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else en)
        try:self.assertEqual(engine.recognize_png(image())['text'],'Correct English source');self.assertEqual(en.calls,1)
        finally:engine.close()
        self.assertTrue(ko.closed and en.closed)

    def test_only_pure_english_reference_line_is_replaced_and_korean_body_kept(self):
        body={'text':'한글 본문과 참고문헌을 보존합니다','box':[40,100,500,30],'words':[]}
        citation={'text':'55. Author wrong citation reference','box':[40,400,600,25],'words':[]}
        ko=Engine({'text':body['text']+'\n'+citation['text'],'lines':[body,citation],'language':'ko','textAngle':0})
        en=Engine({'text':'55. Correct Author, Title (1952), 556.','lines':[{'text':'55. Correct Author, Title (1952), 556.','box':[5,5,550,24],'words':[]}],'language':'en-US'})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else en)
        try:
            result=engine.recognize_png(image())
            self.assertEqual(result['lines'][0],body)
            self.assertEqual(result['lines'][1]['text'],en.result['text'])
            self.assertEqual(result['lines'][1]['box'],citation['box'])
            self.assertEqual(citation['text'],'55. Author wrong citation reference')
            self.assertEqual(result['language'],'ko+en-US');self.assertTrue(result['review'])
        finally:engine.close()

    def test_missing_english_pack_keeps_primary_text_and_requires_review(self):
        ko=Engine({'text':'An English paragraph about history. '*8,'lines':[],'language':'ko'})
        engine=AdaptiveWindowsOcr(languages=['ko'],engine_factory=lambda _:ko)
        try:
            result=engine.recognize_png(image())
            self.assertEqual(result['text'],ko.result['text']);self.assertTrue(result['review'])
        finally:engine.close()

    def test_english_engine_failure_cannot_erase_korean_or_mark_source_bad(self):
        ko=Engine({'text':'A sufficiently long English paragraph. '*6,'lines':[],'language':'ko'})
        def factory(lang):
            if lang=='en-US':raise OcrEngineError('transport failed')
            return ko
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=factory)
        try:
            result=engine.recognize_png(image());self.assertEqual(result['text'],ko.result['text']);self.assertTrue(result['review'])
        finally:engine.close()

    def test_rotation_prevents_unsafe_english_line_cropping(self):
        ko=Engine({'text':'한글 본문을 보존\nEnglish reference citation information','lines':[{'text':'English reference citation information','box':[20,300,400,25]}],'language':'ko','textAngle':3})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else self.fail('unsafe rotated crop'))
        try:self.assertEqual(engine.recognize_png(image())['text'],ko.result['text'])
        finally:engine.close()

    def test_english_request_runtime_failure_preserves_primary_and_stops_retries(self):
        ko=Engine({'text':'A sufficiently long English paragraph. '*6,'lines':[],'language':'ko'})
        class BrokenEngine(Engine):
            def recognize_png(self,png):
                self.calls+=1;raise RuntimeError('Windows OCR request failed')
        en=BrokenEngine({})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else en)
        try:
            for png in (image(),image()+b' '):
                result=engine.recognize_png(png)
                self.assertEqual(result['text'],ko.result['text']);self.assertTrue(result['review'])
            self.assertEqual(en.calls,1)
        finally:engine.close()

    def test_real_memory_failure_is_not_hidden_by_language_fallback(self):
        ko=Engine({'text':'A sufficiently long English paragraph. '*6,'lines':[],'language':'ko'})
        def factory(lang):
            if lang=='en-US':raise MemoryError('not enough memory')
            return ko
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=factory)
        try:
            with self.assertRaises(MemoryError):engine.recognize_png(image())
        finally:engine.close()

    def test_mostly_english_page_keeps_known_korean_line(self):
        body={'text':'The Holy Spirit and a long English paragraph. '*6,'box':[40,100,700,30]}
        korean={'text':'한국어','box':[40,400,100,25]}
        ko=Engine({'text':body['text']+'\n'+korean['text'],'lines':[body,korean],'language':'ko','textAngle':0})
        en=Engine({'text':'Correct English paragraph','lines':[{'text':'Correct English paragraph','box':[5,5,550,24],'words':[]}],'language':'en-US'})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else en)
        try:
            result=engine.recognize_png(image())
            self.assertEqual(result['lines'][-1],korean)
            self.assertIn('한국어',result['text'])
        finally:engine.close()

    def test_rotated_english_crop_keeps_primary_geometry_and_text(self):
        line={'text':'English citation information reference','box':[40,400,600,25]}
        ko=Engine({'text':'한국어\n'+line['text'],'lines':[line],'language':'ko','textAngle':0})
        en=Engine({'text':'Rotated replacement','lines':[{'text':'Rotated replacement','box':[0,0,100,20],'words':[]}],'textAngle':3})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else en)
        try:
            result=engine.recognize_png(image())
            self.assertEqual(result['text'],ko.result['text']);self.assertEqual(result['lines'][0],line)
            self.assertTrue(result['review'])
        finally:engine.close()

    def test_tiny_reference_is_upscaled_and_word_boxes_map_back_to_source(self):
        citation={'text':'55. English citation reference','box':[40,400,600,25]}
        ko=Engine({'text':'한글 본문을 보존합니다\n'+citation['text'],'lines':[citation],'language':'ko','textAngle':0})
        class EnlargedEngine(Engine):
            def recognize_png(self,png):
                with Image.open(io.BytesIO(png)) as im:self.size=im.size
                return super().recognize_png(png)
        en=EnlargedEngine({'text':'55. Correct reference','lines':[{'text':'55. Correct reference','box':[20,10,200,40],'words':[{'text':'Correct','box':[20,10,200,40]}]}]})
        engine=AdaptiveWindowsOcr(languages=['ko','en-US'],engine_factory=lambda lang:ko if lang=='ko' else en)
        try:
            result=engine.recognize_png(image())
            self.assertGreaterEqual(en.size[1],60)
            self.assertEqual(result['lines'][0]['words'][0]['box'],[45,400,100,20])
        finally:engine.close()

if __name__=='__main__':unittest.main()
