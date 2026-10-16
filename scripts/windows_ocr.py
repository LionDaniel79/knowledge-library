"""JSON-lines bridge to the installed Windows OCR engine; no PowerShell policy changes."""
import asyncio, base64, json, sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'.local-python'))
from winrt.windows.media.ocr import OcrEngine
from winrt.windows.globalization import Language
from winrt.windows.storage import StorageFile, FileAccessMode
from winrt.windows.graphics.imaging import BitmapDecoder
from winrt.windows.storage.streams import InMemoryRandomAccessStream, DataWriter


async def run(language):
    engine=OcrEngine.try_create_from_language(Language(language))
    if not engine:raise RuntimeError('Requested OCR language is not installed')
    print(json.dumps({'ready':True,'language':language,'engine':'Windows.Media.Ocr'}),flush=True)
    for line in sys.stdin:
        stream=bitmap=writer=None
        try:
            request=json.loads(line)
            if 'png' in request:
                encoded=request['png']
                if not isinstance(encoded,str) or len(encoded)>44*1024*1024:raise ValueError('OCR image payload too large')
                png=base64.b64decode(encoded,validate=True)
                if not 0<len(png)<=32*1024*1024:raise ValueError('OCR image payload too large')
                stream=InMemoryRandomAccessStream()
                writer=DataWriter(stream)
                writer.write_bytes(png)
                await writer.store_async()
                writer.detach_stream();writer.close();writer=None
                stream.seek(0)
            else:
                file=await StorageFile.get_file_from_path_async(str(Path(request['path']).resolve()))
                stream=await file.open_async(FileAccessMode.READ)
            decoder=await BitmapDecoder.create_async(stream)
            bitmap=await decoder.get_software_bitmap_async()
            if max(bitmap.pixel_width,bitmap.pixel_height)>OcrEngine.max_image_dimension:raise ValueError('Image exceeds OCR dimension limit')
            result=await asyncio.wait_for(engine.recognize_async(bitmap),timeout=45)
            print(json.dumps({'text':'\n'.join(line.text for line in result.lines),'engine':'Windows.Media.Ocr','language':language},ensure_ascii=False),flush=True)
        except Exception as error:print(json.dumps({'error':str(error)}),flush=True)
        finally:
            if bitmap:bitmap.close()
            if writer:writer.close()
            if stream:stream.close()


if __name__=='__main__':asyncio.run(run(sys.argv[1] if len(sys.argv)>1 else 'ko'))
