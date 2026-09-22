"""Materials the prompt slowly wanders through, shared by both one-step engines.

Each is blended with the base prompt's embedding, so the base description is
always present.
"""
DRIFT_STYLES = [
    ('ochre limestone', 'weathered oolitic limestone with red ochre traces, porous prehistoric carved stone'),
    ('mammoth ivory', 'polished mammoth ivory, warm cream tones, fine carved relief'),
    ('mother of pearl', 'iridescent mother of pearl, luminous shell, delicate carved relief'),
    ('smoky glass', 'translucent smoky glass, silver veins, ethereal inner light'),
]
