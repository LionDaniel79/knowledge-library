"""Installed Windows OCR languages only; no model downloads, APIs or guessed text."""
import copy
import hashlib
import io
import math
import unicodedata
from collections import OrderedDict
from PIL import Image
from pdf_ocr import WindowsOcr,OcrEngineError
from pdf_ocr_store import is_resource_error


def letters(text):
    latin=other=0
    for c in unicodedata.normalize('NFKC',str(text)):
        if not c.isalpha():continue
        if unicodedata.name(c,'').startswith('LATIN'):latin+=1
        else:other+=1
    return latin,other


class AdaptiveWindowsOcr:
    def __init__(self,languages=None,engine_factory=WindowsOcr):
        if languages is None:
            from winrt.windows.media.ocr import OcrEngine
            languages=[l.language_tag for l in OcrEngine.available_recognizer_languages]
        if not languages:raise OcrEngineError('설치된 Windows OCR 언어가 없습니다.')
        self.primary_tag=next((l for l in languages if l.startswith('ko')),languages[0])
        self.english_tag=next((l for l in languages if l.lower()=='en-us'),next((l for l in languages if l.startswith('en')),None))
        self.factory=engine_factory;self.primary=engine_factory(self.primary_tag);self.english=None;self.disabled=False;self.cache=OrderedDict()

    def english_result(self,png):
        if not self.english_tag or self.disabled:return None
        try:
            if self.english is None:self.english=self.factory(self.english_tag)
            return self.english.recognize_png(png)
        except (RuntimeError,OSError) as error:
            if is_resource_error(error):raise
            self.disabled=True;return None

    def recognize_png(self,png):
        key=hashlib.sha256(png).digest()
        if key in self.cache:
            self.cache.move_to_end(key);return copy.deepcopy(self.cache[key])
        result=copy.deepcopy(self.primary.recognize_png(png));result.setdefault('language',self.primary_tag)
        review=list(result.get('review',[]));latin,other=letters(result.get('text',''))
        if not self.primary_tag.startswith('en') and latin>=80 and other==0:
            english=self.english_result(png)
            if english and str(english.get('text','')).strip():
                original=result.get('text','')
                result=copy.deepcopy(english);result['language']=self.english_tag
                result['languageEdits']=[{'original':original[:2000],'recognized':result['text'][:2000],'language':self.english_tag}]
            else:review.append('영어 OCR 언어·실행기 확인: 기존 인식 결과 보존')
        elif not self.primary_tag.startswith('en') and abs(float(result.get('textAngle') or 0))<=1:
            eligible=[]
            for i,line in enumerate(result.get('lines',[])):
                n,nonlatin=letters(line.get('text',''))
                if n>=12 and nonlatin==0:eligible.append(i)
            if eligible and not self.english_tag:review.append('영문 인용 확인: 영어 OCR 언어가 설치되어 있지 않습니다.')
            # Keep Korean/mixed lines intact; only pure Latin references are
            # cropped. A multi-line or unreliable crop stays unchanged.
            if eligible and self.english_tag:
                with Image.open(io.BytesIO(png)) as image:
                    edits=[]
                    for i in eligible[:8]:
                        line=result['lines'][i];box=line.get('box',[])
                        if len(box)!=4 or not all(isinstance(v,(int,float)) and math.isfinite(v) for v in box):continue
                        x,y,w,h=box;pad=max(3,round(h*.2));left=max(0,math.floor(x-pad));top=max(0,math.floor(y-pad))
                        right=min(image.width,math.ceil(x+w+pad));bottom=min(image.height,math.ceil(y+h+pad))
                        if right<=left or bottom<=top:continue
                        crop=image.crop((left,top,right,bottom));stream=io.BytesIO()
                        scale=min(2,2500/max(crop.size))
                        if scale>1:
                            enlarged=crop.resize((round(crop.width*scale),round(crop.height*scale)),Image.Resampling.LANCZOS);crop.close();crop=enlarged
                        try:crop.save(stream,format='PNG',compress_level=1);english=self.english_result(stream.getvalue())
                        finally:crop.close()
                        angle=float(english.get('textAngle') or 0) if english else 0
                        if not english or len(english.get('lines',[]))!=1 or not math.isfinite(angle) or abs(angle)>1:
                            review.append('영문 인용 구간 확인: 기존 인식 결과 보존');continue
                        corrected=str(english.get('text','')).strip()
                        if not corrected:continue
                        words=[]
                        for word in english['lines'][0].get('words',[]):
                            wx,wy,ww,wh=word['box'];words.append({'text':word['text'],'box':[left+wx/scale,top+wy/scale,ww/scale,wh/scale]})
                        result['lines'][i]={**line,'text':corrected,'words':words}
                        edits.append({'original':line['text'][:2000],'recognized':corrected[:2000],'box':box,'language':self.english_tag})
                    if edits:
                        result['text']='\n'.join(l['text'] for l in result['lines'])
                        result['language']=self.primary_tag+'+'+self.english_tag;result['languageEdits']=edits
                        review.append('영문 인용 구간 재인식: 원문 비교 후 반영')
        result['review']=list(dict.fromkeys(review));self.cache[key]=copy.deepcopy(result)
        if len(self.cache)>8:self.cache.popitem(last=False)
        return result

    def close(self):
        try:self.primary.close()
        finally:
            if self.english:self.english.close()
            self.cache.clear()
