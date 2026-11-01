/** Words are AND clauses; quoted phrases retain their literal spacing. */
export function pdfSearchTerms(query) {
  if (typeof query !== "string" || query.length > 200)
    throw Error("PDF 검색어는 200자 이내로 입력해 주세요.");
  const terms = [];
  let at = 0;
  const isQuote = (character) => /["“”]/.test(character);
  const syntaxError = () =>
    Error("구문은 큰따옴표로 닫고, 검색어 사이는 공백으로 구분해 주세요.");
  while (at < query.length) {
    if (/\s/.test(query[at])) {
      at++;
      continue;
    }
    let term;
    if (isQuote(query[at])) {
      const straight = query[at++] === '"';
      const start = at;
      while (at < query.length && !isQuote(query[at])) at++;
      if (
        at === query.length ||
        (straight ? query[at] !== '"' : !/[“”]/.test(query[at]))
      )
        throw syntaxError();
      term = query.slice(start, at++);
      if (at < query.length && !/\s/.test(query[at])) throw syntaxError();
    } else {
      const start = at;
      while (at < query.length && !/\s/.test(query[at])) {
        if (isQuote(query[at])) throw syntaxError();
        at++;
      }
      term = query.slice(start, at);
    }
    if ([...term.trim()].length < 2)
      throw Error("검색어를 두 글자 이상 입력해 주세요.");
    terms.push(term);
    if (terms.length > 8)
      throw Error("단어와 따옴표 구문은 합쳐서 8개까지 검색할 수 있습니다.");
  }
  if (!terms.length) throw Error("검색어를 두 글자 이상 입력해 주세요.");
  return terms;
}
