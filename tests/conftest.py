from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def dust2_mini() -> Path:
    """Rounds 1-8 of a de_dust2 match (see make_fixture.py); snapshot ticks start at 1, not 0."""
    return FIXTURES / "dust2_mini"
