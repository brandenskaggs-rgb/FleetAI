"""Export the approved Link silhouette and an outlined Archivo wordmark."""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'brand'
SHAPES = 'M0 760V220L220 0H760V240H310L240 310V760Z M240 1000H780L1000 780V240H760V690L690 760H240Z'
def svg(color, wordmark=False):
    parts=[f'<path fill="{color}" d="{SHAPES}"/>']
    if wordmark:
        font=TTFont(ROOT/'assets/fonts/archivo-var-latin.woff2')
        from fontTools.varLib.instancer import instantiateVariableFont
        font=instantiateVariableFont(font,{'wght':650},inplace=False)
        glyphs=font.getGlyphSet()
        mapping=font.getBestCmap()
        scale=.8
        advance=0
        letters=[]
        for char in 'Fleet AI':
            name=mapping[ord(char)]
            pen=SVGPathPen(glyphs)
            glyphs[name].draw(pen)
            letters.append(f'<path transform="translate({advance},0)" d="{pen.getCommands()}"/>')
            advance+=glyphs[name].width
        parts.append(f'<g fill="{color}" transform="translate(1360,755) scale({scale},-{scale})">'+''.join(letters)+'</g>')
        width=round(1360+advance*scale)
    else:
        width=1000
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 1000" role="img" aria-label="Fleet AI"><title>Fleet AI Link</title>'+''.join(parts)+'</svg>\n'
for name,color in [('','#172225'),('-white','#FFFFFF')]:
    (OUT/f'fleet-ai-mark{name}.svg').write_text(svg(color),encoding='utf8')
    (OUT/f'fleet-ai-logo{name}.svg').write_text(svg(color,True),encoding='utf8')
print('Exported Link brand: outlined wordmarks and marks.')
