"""Conservative, image-only OCR preparation. No LLM, network or guessed text."""
import hashlib
import io
import math
import re
import unicodedata
from PIL import Image, ImageOps

PROFILE = 'body-footnotes-300dpi-v2'
MAX_TILE = 2500


def normalized(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(text))).casefold()


def tile_boxes(width, height, limit=MAX_TILE, overlap=160):
    if min(width,height,limit)<=0 or not 0<overlap<limit//2:
        raise ValueError('Invalid OCR tile dimensions')
    def ranges(size):
        n=max(1,math.ceil((size-overlap)/(limit-overlap)))
        step=math.ceil((size-overlap)/n)
        return [(i*step,min(size,(i+1)*step+overlap)) for i in range(n)]
    return [(x0,y0,x1,y1) for x0,x1 in ranges(width) for y0,y1 in ranges(height)]


def merge_lines(lines,review=None):
    kept=[]
    for line in sorted(lines,key=lambda l:(l['box'][1],l['box'][0])):
        if not str(line.get('text','')).strip():continue
        x,y,w,h=line['box']
        if min(w,h)<=0:continue
        duplicate=False
        for i in range(len(kept)-1,-1,-1):
            old=kept[i]
            ox,oy,ow,oh=old['box']
            intersect=max(0,min(x+w,ox+ow)-max(x,ox))*max(0,min(y+h,oy+oh)-max(y,oy))
            if intersect/max(1,min(w*h,ow*oh))<=.55:continue
            same_text=normalized(line['text'])==normalized(old['text'])
            cross_tile=line.get('_tile') is not None and old.get('_tile') is not None and line['_tile']!=old['_tile']
            if same_text or cross_tile:
                # Prefer the line furthest from a crop seam. A truncated edge
                # fragment must not survive next to its complete recognition.
                preferred=line if line.get('_clearance',0)>old.get('_clearance',0) else old
                if cross_tile and not same_text:
                    fragment=old if preferred is line else line
                    safe_fragment=fragment.get('_clipped') and not preferred.get('_clipped') and normalized(fragment['text']) in normalized(preferred['text'])
                    if not safe_fragment and review is not None:review.append('타일 경계 인식 불일치: 원문 확인')
                kept[i]=preferred;duplicate=True;break
        if not duplicate:kept.append(line)
    if review is not None and any(l.get('_clipped') for l in kept):review.append('타일 경계의 잘린 문장 확인')
    return [{'text':l['text'],'box':l['box']} for l in kept]


def margin_key(line,height):
    original=str(line.get('text','')).strip()
    text=normalized(original)
    x,y,w,h=line['box']
    if not text or len(text)>90:return None
    running_folio=bool(re.search(r'[|ⅠlI1]\s+\d{1,5}$',original))
    if re.match(r'^(?:각주|주[:：]|\d{1,3}[.)]|[*†‡])',text) and not running_folio:return None
    if re.fullmatch(r'[-–—·]*\d{1,5}[-–—·]*',text):return None
    edge='top' if y+h<height*.12 else 'bottom' if y>height*.88 else None
    if not edge:return None
    # Folios often share one OCR line with the running title. Strip only a
    # separate outer token; chapter numbers inside a title remain significant.
    original=re.sub(r'^\d{1,5}(?:\s+[|ⅠlI1])?\s+','',original)
    original=re.sub(r'\s+(?:[|ⅠlI1]\s*)?\d{1,5}$','',original)
    text=normalized(original)
    if len(text)<4:return None
    return (edge,text)


def repeated_margins(pages,height):
    if len(pages)<3:return set()
    samples=[[(margin_key(l,height),tuple(v/height for v in l['box'])) for l in lines if margin_key(l,height)] for lines in pages]
    repeated=set()
    for page in samples:
        for key,geometry in page:
            count=sum(any(other_key==key and same_margin(geometry,other_geometry) for other_key,other_geometry in lines) for lines in samples)
            # Odd/even pages may use different titles. Require at least three
            # distant matches, with the same geometry, for either title.
            if count>=max(3,math.ceil(len(pages)*.3)):repeated.add((*key,*geometry))
    return repeated


def same_margin(a,b):
    # Geometry is relative to page height, matching the document probes.
    # Similar words in a larger or lower chapter title are never a header.
    return abs(a[0]-b[0])<=.025 and abs(a[1]-b[1])<=.012 and abs(a[2]-b[2])<=max(.015,min(a[2],b[2])*.25) and abs(a[3]-b[3])<=max(.003,min(a[3],b[3])*.25)


def filter_body(lines,width,height,repeated,remove_margins=True):
    kept=[];removed=[];review=[]
    for line in lines:
        text=str(line.get('text','')).strip();x,y,w,h=line['box']
        key=margin_key(line,height)
        page_number=bool(re.fullmatch(r'[-–—·\s]*\d{1,5}[-–—·\s]*',text)) and (y+h<height*.07 or y>height*.94)
        if page_number:
            # Windows can split a superscript footnote marker into its own
            # line. Adjacent text makes it unsafe to erase as a folio.
            for other in lines:
                ox,oy,ow,oh=other['box']
                if other is not line and re.search(r'[^\d\W]',other.get('text',''),re.UNICODE) and abs((oy+oh/2)-(y+h/2))<=max(h,oh) and -max(h,oh)<ox-x-w<max(h,oh)*4:
                    page_number=False;break
        matching=key is not None and any(candidate[:2]==key and same_margin(tuple(v/height for v in line['box']),candidate[2:]) for candidate in repeated)
        if remove_margins and (matching or page_number):removed.append(line)
        else:kept.append(line)
    text='\n'.join(l['text'] for l in kept)
    # Do not discard a page just because an author quotes an advertisement.
    if re.search(r'신간\s*(안내|소개)|구매\s*문의|도서\s*주문|정가\s*[:：]|발행인\s*[:：]|ISBN\s*[:：]?|차\s*례|목\s*차',text,re.I):
        review.append('광고·표지·목차·판권 가능성: 본문 여부 확인')
    if '\ufffd' in text:review.append('문자 깨짐 확인')
    return {'lines':kept,'removed':removed,'review':review}


def deskew(image):
    gray=ImageOps.grayscale(image)
    thumb=gray.copy();thumb.thumbnail((850,850))
    ink=ImageOps.invert(thumb).point(lambda p:255 if p>100 else 0)
    def score(angle):
        rotated=ink.rotate(angle,resample=Image.Resampling.BILINEAR,expand=False,fillcolor=0)
        tiny=rotated.resize((1,rotated.height),Image.Resampling.BOX)
        rows=list(tiny.tobytes());tiny.close();rotated.close()
        return sum((a-b)**2 for a,b in zip(rows,rows[1:]))
    initial=score(0);best=max(((score(n*.25),n*.25) for n in range(-12,13)),default=(initial,0))
    angle=best[1] if initial>0 and best[0]>initial*1.15 else 0
    thumb.close();ink.close()
    if angle:
        rotated=gray.rotate(angle,resample=Image.Resampling.BICUBIC,expand=True,fillcolor=255);gray.close();gray=rotated
    result=ImageOps.autocontrast(gray,cutoff=.2);gray.close()
    return result,angle


def png_bytes(image):
    stream=io.BytesIO();image.save(stream,format='PNG',compress_level=1)
    return stream.getvalue()


def result_lines(result,offset=(0,0),scale=1):
    lines=[];records=[]
    for line in result.get('lines',[]):
        box=line.get('box')
        if not isinstance(box,list) or len(box)!=4:continue
        if not all(isinstance(n,(int,float)) and math.isfinite(n) for n in box):continue
        words=line.get('words',[]);groups=[]
        for word in words:
            wb=word.get('box',[])
            if len(wb)!=4 or not all(isinstance(n,(int,float)) and math.isfinite(n) for n in wb):continue
            if groups:
                old=groups[-1][-1]['box']
                gap=wb[0]-(old[0]+old[2])
                if gap>max(old[3],wb[3])*4:groups.append([])
            else:groups.append([])
            groups[-1].append(word)
        records.append((line,groups))
    def gaps(groups):
        return [(a[-1]['box'][0]+a[-1]['box'][2],b[0]['box'][0]) for a,b in zip(groups,groups[1:])]
    for line,groups in records:
        # One large space in a citation is not evidence of columns. Require
        # the same gutter on three distinct OCR rows before splitting lines.
        split=False
        for lo,hi in gaps(groups):
            support=sum(any(min(hi,b)-max(lo,a)>.5*min(hi-lo,b-a) for a,b in gaps(other_groups)) for _,other_groups in records)
            if support>=3:split=True;break
        fragments=[]
        if split:
            for group in groups:
                x=min(w['box'][0] for w in group);y=line['box'][1]
                right=max(w['box'][0]+w['box'][2] for w in group);bottom=max(w['box'][1]+w['box'][3] for w in group)
                fragments.append({'text':' '.join(str(w.get('text','')) for w in group),'box':[x,y,right-x,bottom-y]})
        else:fragments=[line]
        for fragment in fragments:
            x,y,w,h=fragment['box']
            lines.append({'text':str(fragment.get('text',''))[:10000],'box':[offset[0]+x/scale,offset[1]+y/scale,w/scale,h/scale]})
    return lines


def probe(image,recognize):
    small=image.copy();small.thumbnail((MAX_TILE,MAX_TILE));scale=small.width/image.width
    try:
        result=recognize(png_bytes(small))
        return result_lines(result,scale=scale),result
    finally:small.close()


def reading_order(lines,width):
    left=[l for l in lines if l['box'][0]+l['box'][2]<width*.52]
    right=[l for l in lines if l['box'][0]>width*.48]
    if len(left)<3 or len(right)<3:return sorted(lines,key=lambda l:(l['box'][1],l['box'][0]))
    if min(l['box'][0] for l in right)-max(l['box'][0]+l['box'][2] for l in left)<width*.025:
        return sorted(lines,key=lambda l:(l['box'][1],l['box'][0]))
    spanning=[l for l in lines if l not in left and l not in right]
    result=[];start=-1
    # A spanning title/footnote separates column bands; retain it once.
    for separator in sorted(spanning,key=lambda l:l['box'][1])+[{'box':[0,float('inf'),0,0]}]:
        end=separator['box'][1]
        result.extend(sorted((l for l in left if start<l['box'][1]<end),key=lambda l:l['box'][1]))
        result.extend(sorted((l for l in right if start<l['box'][1]<end),key=lambda l:l['box'][1]))
        if math.isfinite(end):result.append(separator)
        start=end-1e-6
    return result


def recognize_body(image,recognize,repeated=None,old_text=''):
    prepared,angle=deskew(image);review=[];all_lines=[];removed=[]
    try:
        initial,meta=probe(prepared,recognize)
        body=filter_body(initial,prepared.width,prepared.height,repeated or set())
        review+=body['review'];removed=body['removed']
        # Only known repeated edge text is masked; unknown ink (tiny footnotes)
        # remains in the full-resolution image, even if the probe missed it.
        if abs(float(meta.get('textAngle') or 0))>1:
            review.append('기울기 좌표 확인: 여백 제거 보류');removed=[]
        from PIL import ImageDraw
        draw=ImageDraw.Draw(prepared)
        for line in removed:
            x,y,w,h=line['box'];draw.rectangle((x-1,y-1,x+w+1,y+h+1),fill=255)
        # Portrait pages fit the OS engine width at 300dpi. Oversized pages
        # are explicitly flagged rather than chopping through words.
        if prepared.width>MAX_TILE:
            review.append('넓은 페이지: 2단·펼친 책 읽기 순서 확인')
            ratio=MAX_TILE/prepared.width
            resized=prepared.resize((MAX_TILE,round(prepared.height*ratio)),Image.Resampling.LANCZOS);prepared.close();prepared=resized
        reliable_geometry=True
        for x0,y0,x1,y1 in tile_boxes(prepared.width,prepared.height):
            crop=prepared.crop((x0,y0,x1,y1))
            try:
                result=recognize(png_bytes(crop))
                lines=result_lines(result,offset=(x0,y0))
                if abs(float(result.get('textAngle') or 0))>1:
                    reliable_geometry=False;review.append('인식 결과의 기울기 좌표 확인: 여백 제거 보류')
                if not lines and result.get('text'):
                    # Old engines without coordinates cannot safely merge tiles.
                    raise ValueError('OCR 좌표 지원 버전이 필요합니다.')
                for line in lines:
                    x,y,w,h=line['box']
                    distances=[]
                    if x0>0:distances.append(x-x0)
                    if x1<prepared.width:distances.append(x1-x-w)
                    if y0>0:distances.append(y-y0)
                    if y1<prepared.height:distances.append(y1-y-h)
                    line['_tile']=(x0,y0,x1,y1)
                    line['_clearance']=min(distances,default=float('inf'))
                    line['_clipped']=bool(distances and min(distances)<=2)
                all_lines.extend(lines)
            finally:crop.close()
        final=filter_body(merge_lines(all_lines,review),prepared.width,prepared.height,repeated or set(),remove_margins=reliable_geometry)
        review+=final['review'];ordered=reading_order(final['lines'],prepared.width)
        text='\n'.join(l['text'] for l in ordered).strip()
        for previous_line in old_text.splitlines():
            heading=normalized(previous_line)
            if re.fullmatch(r'[ivxlcdm]{1,8}',heading) and heading not in normalized(text):
                review.append('기존 로마숫자 절 제목 누락 가능성: 원문 확인');break
        if old_text.strip() and len(normalized(text))<len(normalized(old_text))*.55:
            review.append('기존보다 인식 분량 감소: 누락 확인')
        if not text:review.append('본문 인식 결과 없음')
        return {'text':text,'lines':ordered,'removed':removed+final['removed'],'review':list(dict.fromkeys(review)),'profile':PROFILE,'dpi':300,'deskewAngle':angle,'width':prepared.width,'height':prepared.height,'engine':'Windows.Media.Ocr','language':'ko','image_hash':hashlib.sha256(png_bytes(prepared)).hexdigest()}
    finally:prepared.close()
