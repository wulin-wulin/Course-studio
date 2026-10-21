"""Uploaded textbook document services."""

from .store import (
    DOCUMENT_SCHEMA,
    OUTLINE_SCHEMA,
    DocumentConflictError,
    DocumentError,
    DocumentNotFoundError,
    DocumentNotReadyError,
    DocumentParseError,
    DocumentParserUnavailableError,
    DocumentStorageError,
    DocumentStore,
    DocumentTooLargeError,
    DocumentUnsupportedMediaTypeError,
    DocumentValidationError,
    get_document_store,
)
from .binding import (
    BINDING_SCHEMA,
    TextbookBinding,
    TextbookBindingError,
    bind_textbook_workspace,
    course_id_for_document,
)
from .structure import (
    TextbookStructureIntegrityError,
    assert_textbook_source_unchanged,
)
from .markdown_parser import (
    MATERIAL_SCHEMA,
    MARKDOWN_PARSER_NAME,
    build_markdown_artifacts,
    parse_markdown_document,
)

__all__ = [
    "DOCUMENT_SCHEMA",
    "OUTLINE_SCHEMA",
    "DocumentConflictError",
    "DocumentError",
    "DocumentNotFoundError",
    "DocumentNotReadyError",
    "DocumentParseError",
    "DocumentParserUnavailableError",
    "DocumentStorageError",
    "DocumentStore",
    "DocumentTooLargeError",
    "DocumentUnsupportedMediaTypeError",
    "DocumentValidationError",
    "get_document_store",
    "BINDING_SCHEMA",
    "TextbookBinding",
    "TextbookBindingError",
    "bind_textbook_workspace",
    "course_id_for_document",
    "TextbookStructureIntegrityError",
    "assert_textbook_source_unchanged",
    "MATERIAL_SCHEMA",
    "MARKDOWN_PARSER_NAME",
    "build_markdown_artifacts",
    "parse_markdown_document",
]
