import unittest
import convert_ireaditnow as converter

class ConversionTests(unittest.TestCase):
    def test_core_data_inline_images_drop_only_the_storage_marker(self):
        self.assertEqual(converter.inline_image(b'\x01\xff\xd8\xff\x00'), b'\xff\xd8\xff\x00')
        self.assertEqual(converter.inline_image(b'\xff\xd8\xff\x00'), b'\xff\xd8\xff\x00')

    def test_dates_and_missing_format_are_not_invented(self):
        self.assertEqual(converter.source_date(0), None)
        self.assertEqual(converter.source_date(None), None)
        self.assertEqual(converter.source_date(813024000), '2026-10-07')
        self.assertEqual(converter.book_format('전자책'), 'ebook')
        self.assertEqual(converter.book_format(''), 'unknown')
        self.assertEqual(converter.book_format('양장본'), 'paper')

    def test_preserves_original_records_and_does_not_guess_completion(self):
        tables={name:[] for name in converter.TABLES}
        tables['ZBOOK']=[{'Z_PK':1,'ZUUID':'book-1','ZTITLE':'원본 책','ZAUTHOR':'저자','ZFORMAT':'전자책','ZSTATUS':32,'ZTIMESTAMP':0}]
        tables['ZREADSESSION']=[{'Z_PK':5,'ZUUID':'session-1','ZBOOK':1,'ZSTATUS':3,'ZSTARTREADING':100,'ZFINISHREADING':200}]
        tables['ZBOOKMARK']=[{'Z_PK':6,'ZSESSION':5,'ZPAGE':42,'ZTIMESTAMP':150}]
        tables['ZREVIEW']=[{'Z_PK':7,'ZBOOK':1,'ZSHORTREVIEW':'좋은 문장','ZFULLREVIEW':None}, {'Z_PK':8,'ZBOOK':1,'ZSHORTREVIEW':''}]
        tables['ZNOTE']=[{'Z_PK':9,'ZBOOK':1,'ZUUID':'note-1','ZNOTE':'나의 생각'}]
        result=converter.convert(tables,'library-1','a'*64)
        self.assertEqual(result['books'][0]['formats'],['ebook'])
        self.assertEqual(result['books'][0]['sourceData']['sessions'][0]['statusCode'],3)
        self.assertEqual(result['books'][0]['sourceData']['sessions'][0]['bookmarks'][0]['page'],42)
        self.assertEqual(len(result['notes']),2)
        self.assertEqual(result['notes'][0]['bookSourceId'],'book-1')
        self.assertEqual(len(result['originalTables']['ZREVIEW']),2)
        self.assertNotIn('cycles',result)

if __name__=='__main__': unittest.main()
