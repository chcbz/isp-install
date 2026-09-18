#!/usr/bin/env python3
"""Version-pinned local delivery helper for private workspace Agent runs.

It gives Codex a real, local producer and re-opener for the document/image formats
that the private bridge allows. It never reads files outside the explicit paths passed
by the private run and never performs network I/O.
"""
from __future__ import print_function

import argparse
import io
import json
import os
import shutil
import sys
import textwrap
from datetime import datetime

MIME_PNG = 'image/png'
MIME_JPEG = 'image/jpeg'
MIME_PDF = 'application/pdf'
MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
MIME_PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
SUPPORTED = (MIME_PNG, MIME_JPEG, MIME_PDF, MIME_DOCX, MIME_XLSX, MIME_PPTX)


def _imports():
    from docx import Document
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from openpyxl import Workbook, load_workbook
    from PIL import Image, ImageDraw, ImageFont
    from PyPDF2 import PdfFileReader, PdfFileWriter
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    return {
        'Document': Document, 'Presentation': Presentation, 'Inches': Inches, 'Pt': Pt,
        'Workbook': Workbook, 'load_workbook': load_workbook, 'Image': Image,
        'ImageDraw': ImageDraw, 'ImageFont': ImageFont, 'PdfFileReader': PdfFileReader,
        'PdfFileWriter': PdfFileWriter, 'A4': A4, 'canvas': canvas
    }


def clean_text(value, default='未提供需求'):
    value = (value or '').strip()
    return value[:4000] if value else default


def wrapped(value, width=42):
    return textwrap.wrap(clean_text(value), width=width) or ['未提供需求']


def _font(size):
    # Degrade predictably when CJK fonts are not installed. Pillow still produces a valid image.
    for path in ('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                 '/usr/share/fonts/chinese/simhei.ttf',
                 '/usr/share/fonts/chinese/simsun.ttc',
                 '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if os.path.exists(path):
            try:
                from PIL import ImageFont
                return ImageFont.truetype(path, size=size)
            except Exception:
                pass
    from PIL import ImageFont
    return ImageFont.load_default()


def create_image(lib, output, instruction, source=None, jpeg=False):
    Image, ImageDraw = lib['Image'], lib['ImageDraw']
    if source:
        image = Image.open(source).convert('RGB')
        image.thumbnail((1600, 1000))
        canvas = image.copy()
    else:
        canvas = Image.new('RGB', (1200, 675), '#13253f')
    draw = ImageDraw.Draw(canvas)
    width, height = canvas.size
    overlay_top = max(0, height - max(200, height // 3))
    draw.rectangle((0, overlay_top, width, height), fill=(8, 18, 31))
    draw.text((36, overlay_top + 28), 'Agent 交付件', fill='white', font=_font(30))
    y = overlay_top + 76
    for line in wrapped(instruction, 34)[:6]:
        draw.text((36, y), line, fill='#dfefff', font=_font(22))
        y += 32
    if jpeg:
        canvas.save(output, format='JPEG', quality=92, optimize=True)
    else:
        canvas.save(output, format='PNG', optimize=True)


def create_docx(lib, output, instruction, source=None):
    Document = lib['Document']
    if source:
        document = Document(source)
        document.add_page_break()
        document.add_heading('本次 Agent 修改说明', level=1)
    else:
        document = Document()
        document.add_heading('Agent 交付文档', level=0)
        document.add_heading('需求说明', level=1)
    document.add_paragraph(clean_text(instruction))
    document.add_paragraph('生成时间：' + datetime.utcnow().isoformat() + 'Z')
    document.save(output)


def create_xlsx(lib, output, instruction, source=None):
    Workbook, load_workbook = lib['Workbook'], lib['load_workbook']
    if source:
        workbook = load_workbook(source, data_only=False)
    else:
        workbook = Workbook()
        sheet = workbook.active
        sheet.title = '交付说明'
        sheet['A1'] = 'Agent 交付表格'
    sheet = workbook['修改说明'] if '修改说明' in workbook.sheetnames else workbook.create_sheet('修改说明')
    sheet['A1'] = '需求说明'
    sheet['B1'] = clean_text(instruction)
    sheet['A2'] = '生成时间'
    sheet['B2'] = datetime.utcnow().isoformat() + 'Z'
    sheet.column_dimensions['A'].width = 18
    sheet.column_dimensions['B'].width = 72
    workbook.save(output)


def create_pptx(lib, output, instruction, source=None):
    Presentation, Inches, Pt = lib['Presentation'], lib['Inches'], lib['Pt']
    presentation = Presentation(source) if source else Presentation()
    if source and presentation.slides:
        slide = presentation.slides[0]
        title = slide.shapes.title
        if title is not None:
            title.text = title.text or '已更新演示文稿'
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = '本次 Agent 修改说明' if source else 'Agent 交付演示'
    body = slide.placeholders[1].text_frame
    body.clear()
    for index, line in enumerate(wrapped(instruction, 40)[:10]):
        paragraph = body.paragraphs[0] if index == 0 else body.add_paragraph()
        paragraph.text = line
        paragraph.font.size = Pt(20)
    presentation.save(output)


def create_pdf(lib, output, instruction, source=None):
    PdfFileReader, PdfFileWriter, A4, canvas = lib['PdfFileReader'], lib['PdfFileWriter'], lib['A4'], lib['canvas']
    # ReportLab creates a valid append-only change note. With an input, preserve every original
    # page and append a clearly labelled modification page rather than silently rewriting layout.
    note = io.BytesIO()
    pdf = canvas.Canvas(note, pagesize=A4)
    pdf.setTitle('Agent 交付 PDF')
    pdf.setFont('Helvetica', 18)
    pdf.drawString(48, 800, 'Agent Delivery PDF' if not source else 'Agent Modification Notes')
    y = 768
    pdf.setFont('Helvetica', 11)
    for line in wrapped(instruction, 82)[:42]:
        pdf.drawString(48, y, line.encode('ascii', 'replace').decode('ascii'))
        y -= 16
    pdf.save()
    note.seek(0)
    writer = PdfFileWriter()
    if source:
        original = PdfFileReader(source, strict=True)
        if original.isEncrypted:
            raise ValueError('encrypted PDFs are not supported')
        for page_index in range(original.getNumPages()):
            writer.addPage(original.getPage(page_index))
    generated = PdfFileReader(note, strict=True)
    writer.addPage(generated.getPage(0))
    with open(output, 'wb') as target:
        writer.write(target)


def create(args):
    lib = _imports()
    output = os.path.abspath(args.output)
    source = os.path.abspath(args.input) if args.input else None
    if source and not os.path.isfile(source):
        raise ValueError('declared input does not exist')
    parent = os.path.dirname(output)
    if not os.path.isdir(parent):
        raise ValueError('declared output directory does not exist')
    if args.mime == MIME_PNG:
        create_image(lib, output, args.instruction, source, jpeg=False)
    elif args.mime == MIME_JPEG:
        create_image(lib, output, args.instruction, source, jpeg=True)
    elif args.mime == MIME_DOCX:
        create_docx(lib, output, args.instruction, source)
    elif args.mime == MIME_XLSX:
        create_xlsx(lib, output, args.instruction, source)
    elif args.mime == MIME_PPTX:
        create_pptx(lib, output, args.instruction, source)
    elif args.mime == MIME_PDF:
        create_pdf(lib, output, args.instruction, source)
    else:
        raise ValueError('unsupported MIME type')
    validate(argparse.Namespace(mime=args.mime, file=output))


def validate(args):
    lib = _imports()
    path = os.path.abspath(args.file)
    if not os.path.isfile(path) or os.path.getsize(path) < 1:
        raise ValueError('file is missing or empty')
    if args.mime in (MIME_PNG, MIME_JPEG):
        image = lib['Image'].open(path)
        image.verify()
        return
    if args.mime == MIME_DOCX:
        lib['Document'](path)
        return
    if args.mime == MIME_XLSX:
        workbook = lib['load_workbook'](path, read_only=True, data_only=False)
        workbook.close()
        return
    if args.mime == MIME_PPTX:
        presentation = lib['Presentation'](path)
        if len(presentation.slides) < 1:
            raise ValueError('presentation must contain at least one slide')
        return
    if args.mime == MIME_PDF:
        document = lib['PdfFileReader'](path, strict=True)
        if document.isEncrypted or document.getNumPages() < 1:
            raise ValueError('PDF must be an unencrypted document with at least one page')
        return
    raise ValueError('unsupported MIME type')


def health(_args):
    lib = _imports()
    versions = {}
    for module in ('docx', 'pptx', 'openpyxl', 'PIL', 'PyPDF2', 'reportlab'):
        imported = __import__(module)
        versions[module] = getattr(imported, '__version__', 'present')
    print(json.dumps({'ok': bool(lib), 'supportedMimeTypes': list(SUPPORTED), 'versions': versions}, sort_keys=True))


def main(argv=None):
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='command')
    create_parser = commands.add_parser('create')
    create_parser.add_argument('--mime', choices=SUPPORTED, required=True)
    create_parser.add_argument('--output', required=True)
    create_parser.add_argument('--instruction', required=True)
    create_parser.add_argument('--input')
    create_parser.set_defaults(func=create)
    validate_parser = commands.add_parser('validate')
    validate_parser.add_argument('--mime', choices=SUPPORTED, required=True)
    validate_parser.add_argument('--file', required=True)
    validate_parser.set_defaults(func=validate)
    health_parser = commands.add_parser('health')
    health_parser.set_defaults(func=health)
    args = parser.parse_args(argv)
    if not getattr(args, 'command', None):
        parser.error('a command is required')
    try:
        args.func(args)
    except Exception as error:
        print('delivery-tool error: {0}'.format(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
