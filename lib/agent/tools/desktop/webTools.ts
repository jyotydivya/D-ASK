// ─────────────────────────────────────────────────────────────────────────────
// D-ASK Web Tools — Real search results, weather data, and news
// Ported from Mark-LV actions/web_search.py — actually scrapes results
// instead of opening browser tabs.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface WeatherData {
  location: string;
  temperature: string;
  condition: string;
  humidity: string;
  wind: string;
  forecast: string;
}

interface NewsResult {
  title: string;
  source: string;
  url: string;
  snippet: string;
}

export class WebToolsService {
  /**
   * Real web search using DuckDuckGo HTML scraping.
   * Returns actual search results with titles, URLs, and snippets.
   */
  public async searchWeb(query: string): Promise<{ success: boolean; message: string; results?: SearchResult[] }> {
    try {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

      // Use PowerShell to fetch and parse the HTML
      const psScript = `
$ProgressPreference = 'SilentlyContinue'
try {
  $response = Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 10 -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  $html = $response.Content

  # Extract results using regex — DuckDuckGo HTML wraps results in <a class="result__a"> and <a class="result__snippet">
  $results = @()
  $pattern = '<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([^<]*)</a>'
  $snippetPattern = '<a class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)</a>'
  
  $titleMatches = [regex]::Matches($html, $pattern)
  $snippetMatches = [regex]::Matches($html, $snippetPattern)
  
  for ($i = 0; $i -lt [math]::Min($titleMatches.Count, 5); $i++) {
    $resultUrl = $titleMatches[$i].Groups[1].Value
    $title = $titleMatches[$i].Groups[2].Value -replace '<[^>]+>', '' -replace '&amp;', '&' -replace '&#x27;', "'" -replace '&quot;', '"'
    $snippet = if ($i -lt $snippetMatches.Count) { $snippetMatches[$i].Groups[1].Value -replace '<[^>]+>', '' -replace '&amp;', '&' } else { '' }
    
    # DuckDuckGo wraps URLs in a redirect — extract the actual URL
    if ($resultUrl -match 'uddg=([^&]+)') {
      $resultUrl = [System.Uri]::UnescapeDataString($matches[1])
    }
    
    $results += @{title=$title; url=$resultUrl; snippet=$snippet}
  }
  
  $results | ConvertTo-Json -Compress
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
}
`;

      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 15000 });

      const trimmed = stdout.trim();
      if (trimmed.startsWith("ERROR:")) {
        // Fallback: just open in browser
        return await this.openInBrowser(query);
      }

      try {
        let results: SearchResult[];
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          results = parsed.map((r: any) => ({
            title: r.title || "No title",
            url: r.url || "",
            snippet: r.snippet || "",
          }));
        } else if (parsed.title) {
          results = [{
            title: parsed.title || "No title",
            url: parsed.url || "",
            snippet: parsed.snippet || "",
          }];
        } else {
          return await this.openInBrowser(query);
        }

        if (results.length === 0) {
          return await this.openInBrowser(query);
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");

        return {
          success: true,
          message: `Found ${results.length} results for "${query}":\n\n${formatted}`,
          results,
        };
      } catch {
        return await this.openInBrowser(query);
      }
    } catch (err) {
      return await this.openInBrowser(query);
    }
  }

  /**
   * Real weather data from wttr.in API.
   * Returns structured weather information.
   */
  public async checkWeather(location?: string): Promise<{ success: boolean; message: string; data?: WeatherData }> {
    try {
      const loc = location ? encodeURIComponent(location) : "";
      const url = `https://wttr.in/${loc}?format=j1`;

      const psScript = `
$ProgressPreference = 'SilentlyContinue'
try {
  $response = Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 10
  Write-Output $response.Content
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
}
`;

      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 15000 });

      const trimmed = stdout.trim();
      if (trimmed.startsWith("ERROR:")) {
        return { success: false, message: `Weather fetch failed: ${trimmed}` };
      }

      try {
        const data = JSON.parse(trimmed);
        const current = data.current_condition?.[0];
        const area = data.nearest_area?.[0];
        const forecast = data.weather?.[0];

        if (!current) {
          return { success: false, message: "Could not parse weather data." };
        }

        const locationName = area
          ? `${area.areaName?.[0]?.value || ""}, ${area.country?.[0]?.value || ""}`
          : (location || "Current location");

        const weatherData: WeatherData = {
          location: locationName,
          temperature: `${current.temp_C}°C (${current.temp_F}°F)`,
          condition: current.weatherDesc?.[0]?.value || "Unknown",
          humidity: `${current.humidity}%`,
          wind: `${current.windspeedKmph} km/h ${current.winddir16Point}`,
          forecast: forecast
            ? `High: ${forecast.maxtempC}°C, Low: ${forecast.mintempC}°C`
            : "N/A",
        };

        const message = [
          `🌡️ Weather for ${weatherData.location}:`,
          `Temperature: ${weatherData.temperature}`,
          `Condition: ${weatherData.condition}`,
          `Humidity: ${weatherData.humidity}`,
          `Wind: ${weatherData.wind}`,
          `Today: ${weatherData.forecast}`,
        ].join("\n");

        return { success: true, message, data: weatherData };
      } catch {
        return { success: false, message: "Failed to parse weather response." };
      }
    } catch (err) {
      return { success: false, message: `Weather error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Fetch news headlines using DuckDuckGo news.
   */
  public async fetchNews(topic?: string): Promise<{ success: boolean; message: string; results?: NewsResult[] }> {
    try {
      const query = topic ? encodeURIComponent(topic) : "latest+news";
      const url = `https://html.duckduckgo.com/html/?q=${query}+news`;

      const psScript = `
$ProgressPreference = 'SilentlyContinue'
try {
  $response = Invoke-WebRequest -Uri '${url}' -UseBasicParsing -TimeoutSec 10 -UserAgent 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  $html = $response.Content
  $results = @()
  $pattern = '<a rel="nofollow" class="result__a" href="([^"]*)"[^>]*>([^<]*)</a>'
  $snippetPattern = '<a class="result__snippet"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)</a>'
  $titleMatches = [regex]::Matches($html, $pattern)
  $snippetMatches = [regex]::Matches($html, $snippetPattern)
  for ($i = 0; $i -lt [math]::Min($titleMatches.Count, 5); $i++) {
    $resultUrl = $titleMatches[$i].Groups[1].Value
    $title = $titleMatches[$i].Groups[2].Value -replace '<[^>]+>', ''
    $snippet = if ($i -lt $snippetMatches.Count) { $snippetMatches[$i].Groups[1].Value -replace '<[^>]+>', '' } else { '' }
    if ($resultUrl -match 'uddg=([^&]+)') { $resultUrl = [System.Uri]::UnescapeDataString($matches[1]) }
    $results += @{title=$title; url=$resultUrl; snippet=$snippet; source='DuckDuckGo News'}
  }
  $results | ConvertTo-Json -Compress
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
}
`;

      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command", psScript
      ], { timeout: 15000 });

      const trimmed = stdout.trim();
      if (trimmed.startsWith("ERROR:") || !trimmed) {
        return { success: false, message: `News fetch failed for "${topic || "latest"}"` };
      }

      try {
        let results: NewsResult[];
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          results = parsed.map((r: any) => ({
            title: r.title || "No title",
            source: r.source || "Web",
            url: r.url || "",
            snippet: r.snippet || "",
          }));
        } else if (parsed.title) {
          results = [{ title: parsed.title, source: parsed.source || "Web", url: parsed.url || "", snippet: parsed.snippet || "" }];
        } else {
          return { success: false, message: "No news results found." };
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
        ).join("\n\n");

        return {
          success: true,
          message: `📰 News for "${topic || "latest"}":\n\n${formatted}`,
          results,
        };
      } catch {
        return { success: false, message: "Failed to parse news response." };
      }
    } catch (err) {
      return { success: false, message: `News error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Fallback: open a DuckDuckGo search in the browser.
   */
  private async openInBrowser(query: string): Promise<{ success: boolean; message: string }> {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://duckduckgo.com/?q=${encodedQuery}`;

    try {
      await execFileAsync("cmd.exe", ["/c", `start "" "${url}"`], { timeout: 5000 });
      return { success: true, message: `Opened web search for: ${query}` };
    } catch (err) {
      return { success: false, message: `Failed to open web search: ${err}` };
    }
  }
}

export const webToolsService = new WebToolsService();
