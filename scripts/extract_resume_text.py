#!/usr/bin/env python3
import json
import sys
from pathlib import Path


def extract_pdf(path: Path) -> str:
    import pdfplumber

    parts = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text)
    return "\n\n".join(parts)


def extract_docx(path: Path) -> str:
    import docx

    document = docx.Document(path)
    parts = [paragraph.text for paragraph in document.paragraphs if paragraph.text.strip()]
    return "\n".join(parts)


def extract_text(path: Path) -> str:
    suffix = path.suffix.lower()

    if suffix == ".pdf":
        return extract_pdf(path)
    if suffix == ".docx":
        return extract_docx(path)
    if suffix in {".txt", ".md"}:
        return path.read_text(encoding="utf-8", errors="replace")

    raise ValueError(f"Unsupported resume file type: {suffix}")


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"ok": False, "error": "Usage: extract_resume_text.py <file>"}))
        return 2

    path = Path(sys.argv[1])
    try:
        text = extract_text(path)
        print(json.dumps({"ok": True, "text": text}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
