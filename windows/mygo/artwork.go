package main

import (
	"bytes"
	"context"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strings"

	"github.com/egoist/mygo/ui"
)

var (
	heartIcon    = outlineIcon("M12 20S3 14.5 3 8.8A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 9 2.8C21 14.5 12 20 12 20z")
	serverIcon   = outlineIcon("M4 5h16v6H4zM4 13h16v6H4zM7 8h.1M7 16h.1")
	accountIcon  = outlineIcon("M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 20a8 8 0 0 1 16 0")
	brandIcon    = outlineIcon("M2 12h3l3-7 4 14 4-12 3 5h3")
	searchIcon   = outlineIcon("M21 21l-5-5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0z")
	libraryIcon  = outlineIcon("M4 5v14M9 5v14M14 6l5 12")
	playlistIcon = outlineIcon("M4 6h16M4 12h16M4 18h11")
	settingsIcon = outlineIcon("M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4")
	closeIcon    = outlineIcon("M6 6l12 12M18 6L6 18")
	downIcon     = outlineIcon("M5 9l7 7 7-7")
	moreIcon     = solidIcon("M7 12a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0m6.5 0a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0m6.5 0a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0")
	queueIcon    = outlineIcon("M4 6h16M4 11h16M4 16h8M16 15v6l4-3z")
	volumeIcon   = outlineIcon("M4 9h4l5-4v14l-5-4H4zM16 8a6 6 0 0 1 0 8m3-10a9 9 0 0 1 0 12")
	playIcon     = solidIcon("M8 4.5v15L20 12z")
	pauseIcon    = solidIcon("M7 5h4v14H7zM14 5h4v14h-4z")
	nextIcon     = solidIcon("M4 5v14l12-7zM17 5h2.5v14H17z")
	prevIcon     = solidIcon("M20 5v14L8 12zM4.5 5H7v14H4.5z")
)

func outlineIcon(path string) *ui.SVG {
	return ui.MustParseSVG([]byte("<svg viewBox='0 0 24 24'><path fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round' d='" + path + "'/></svg>"))
}

func solidIcon(path string) *ui.SVG {
	return ui.MustParseSVG([]byte("<svg viewBox='0 0 24 24'><path d='" + path + "'/></svg>"))
}

func drawIcon(c *ui.Context, glyph *ui.SVG, size float32, color ui.Color) {
	ui.Icon(c, glyph).Size(size, size).TextColor(color).AccessHidden(true)
}

// Original vector artwork for the preview catalogue.
var coverArt = []*ui.SVG{
	illustration("<defs><linearGradient id='sky' x2='1' y2='1'><stop stop-color='#0B293C'/><stop offset='1' stop-color='#398F85'/></linearGradient></defs>" +
		"<path fill='url(#sky)' d='M0 0h320v320H0z'/><circle cx='209' cy='98' r='49' fill='#F0D7A3'/>" +
		"<path fill='#69AA9F' d='M0 177l62-41 54 30 39-18 59 26 63-37 43 18v165H0z'/>" +
		"<path fill='#256C71' d='M0 188q57-30 130 0t190-8v140H0z'/><path fill='#103B4F' d='M0 222q75-33 152 1t168-9v106H0z'/>" +
		"<path fill='none' stroke='#80C9B5' stroke-opacity='.66' stroke-width='2' d='M-8 230q74-29 156-1t176-9M-8 245q74-29 156-1t176-9M-8 260q74-29 156-1t176-9M-8 275q74-29 156-1t176-9'/>"),
	illustration("<defs><linearGradient id='blue' x2='1' y2='1'><stop stop-color='#18254D'/><stop offset='1' stop-color='#6481C5'/></linearGradient></defs>" +
		"<path fill='url(#blue)' d='M0 0h320v320H0z'/><circle cx='160' cy='154' r='98' fill='#344D85'/>" +
		"<g fill='none' stroke='#A2BEEC' stroke-width='1.6'><circle cx='160' cy='154' r='107'/><circle cx='160' cy='154' r='76'/><circle cx='160' cy='154' r='53'/><path d='M160 26v256M32 154h256'/></g>" +
		"<path fill='#E6E9D4' d='M120 130h80v48h-80z'/><path fill='none' stroke='#617DB4' stroke-width='2' d='M120 131l40 30 40-30'/>" +
		"<circle cx='214' cy='91' r='6' fill='#F5D99C'/><circle cx='86' cy='215' r='4' fill='#A9DBDF'/>"),
	illustration("<defs><linearGradient id='dawn' x2='.8' y2='1'><stop stop-color='#3B2142'/><stop offset='1' stop-color='#CF8358'/></linearGradient></defs>" +
		"<path fill='url(#dawn)' d='M0 0h320v320H0z'/><circle cx='163' cy='155' r='74' fill='#F8C587'/>" +
		"<path fill='#A6535B' d='M0 191l65-31 46 28 52-14 59 30 98-49v165H0z'/>" +
		"<path fill='#67394D' d='M0 211l94-15 44 22 76-16 106 19v99H0z'/><path fill='#34223C' d='M0 240l49-22 77 35 85-18 109 28v57H0z'/>" +
		"<path fill='none' stroke='#F9D5A1' stroke-opacity='.75' d='M27 67h48M38 74h26M227 112h42'/>"),
	illustration("<defs><linearGradient id='night' x2='1' y2='1'><stop stop-color='#241E48'/><stop offset='1' stop-color='#695399'/></linearGradient></defs>" +
		"<path fill='url(#night)' d='M0 0h320v320H0z'/><path fill='#AD8FD0' d='M0 239l66-44 52 14 67-60 64 61 71-15v125H0z'/>" +
		"<path fill='#443766' d='M0 261l108-44 43 20 46-21 123 48v56H0z'/>" +
		"<path fill='none' stroke='#F2DAB8' stroke-width='1.5' d='M30 135q56-38 125-25t139-41M21 152q56-38 125-25t139-41'/>" +
		"<g fill='#F2DAB8'><circle cx='83' cy='52' r='3'/><circle cx='129' cy='88' r='2'/><circle cx='253' cy='53' r='4'/><circle cx='218' cy='141' r='3'/></g>"),
}

var coverTints = func() []ui.Color {
	tints := make([]ui.Color, len(coverArt))
	for i, art := range coverArt {
		tints[i] = coverTint(art.Image(20, 20, nil))
	}
	return tints
}()

func coverTint(pixels image.Image) ui.Color {
	const size = 20
	box := pixels.Bounds()
	var red, green, blue, total int
	for y := range size {
		for x := range size {
			r, g, b, a := pixels.At(box.Min.X+x*box.Dx()/size, box.Min.Y+y*box.Dy()/size).RGBA()
			if a != 0xffff {
				continue
			}
			// Give more weight to colorful pixels than to grays.
			r, g, b = r>>8, g>>8, b>>8
			weight := int(max(r, g, b) - min(r, g, b))
			red += int(r) * weight
			green += int(g) * weight
			blue += int(b) * weight
			total += weight
		}
	}
	if total == 0 {
		return ui.Hex("#006961")
	}
	return ui.RGB(uint8(red/total), uint8(green/total), uint8(blue/total))
}

func fetchAlbumArt(ctx context.Context, client *http.Client, raw string) image.Image {
	if rest, httpURL := strings.CutPrefix(raw, "http://"); httpURL {
		raw = "https://" + rest
	}
	address, err := validateSource(raw)
	if err != nil {
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil
	}
	const limit = 4 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || len(data) > limit {
		return nil
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width > 2048 || config.Height > 2048 {
		return nil
	}
	picture, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	return picture
}

func illustration(content string) *ui.SVG {
	return ui.MustParseSVG([]byte("<svg viewBox='0 0 320 320'>" + content + "</svg>"))
}

func cover(c *ui.Context, track int, size, radius float32) {
	ui.Image(c, coverArt[track]).Size(size, size).Radius(radius).Clip().AccessHidden(true)
}

func sourceCover(c *ui.Context, size, radius float32) {
	t := c.Theme()
	ui.Row(c).Size(size, size).Radius(radius).Background(t.SurfaceHover).
		AlignItems(ui.Center).Justify(ui.Center).Children(func() {
		drawIcon(c, brandIcon, size*.44, t.Accent)
	})
}
