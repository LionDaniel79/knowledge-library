"""Conservative material scope, derived only from inventory metadata (no page reads)."""
import re

SCOPE_VERSION = '2026-10-13.3'


def classify(relative_path, title=''):
    path = str(relative_path).replace('\\', '/')
    parts = path.split('/')
    name = parts[-1] + ' ' + title
    text = path + ' ' + title
    if re.search(r'간행물|학술지|정기간행|(^|[\s_/\\-])(journals?|periodicals?|magazines?|newsletters?)([\s_/\\.-]|$)|월간목회|목회와신학', text, re.I):
        return ('metadata_only', 'periodical', '간행물·학술지 자료')
    # These are article collections in the user's inventory, not mixed book folders.
    if re.search(r'신학지남|기독논문자료|학위\s*논문|석사\s*논문|박사\s*논문|학술논문|연구논문|소논문|아티클 모음|논문집|논문들|dissertations?|theses', text, re.I):
        return ('metadata_only', 'paper', '논문·학술 아티클 자료')
    if re.search(r'(^|[\s_\[(/-])(논문|thesis|article|journal|paper)([\s_\])/.-]|$)', name, re.I):
        return ('metadata_only', 'paper', '파일명에 논문·아티클 표시')
    if re.search(r'논문.*(책|아티클)|(^|/)논문(/|$)', text, re.I):
        return ('metadata_only', 'review', '책·논문 혼합: 범위 확인 대기')
    return ('full', 'book', '논문·간행물 표시 없는 도서 (강해·주석 포함)')
