import urllib.request
import urllib.error
import urllib.parse
import json

headers = {
    'X-RapidAPI-Key': '2f8ef458aemsha05f2f0c4ce9b06p1f15fejsn702617d3780e',
    'X-RapidAPI-Host': 'sofascore.p.rapidapi.com'
}
base_url = 'https://sofascore.p.rapidapi.com'

prefixes = ['', '/v1']
modules = ['matches', 'tournaments', 'categories', 'leagues', 'competitions', 'events', 'sports']
actions = ['list-live', 'get-live', 'live', 'list-by-date', 'get-by-date', 'by-date', 'schedule', 'list-top', 'get-top', 'top']

endpoints_to_test = []
for p in prefixes:
    for m in modules:
        for a in actions:
            endpoints_to_test.append(f"{p}/{m}/{a}")
            endpoints_to_test.append(f"{p}/{m}/v1/{a}")
            endpoints_to_test.append(f"{p}/{m}/v2/{a}")

print(f"Testing {len(endpoints_to_test)} combinations...")

found = []
for path in endpoints_to_test:
    req = urllib.request.Request(base_url + path, headers=headers)
    try:
        with urllib.request.urlopen(req) as response:
            print(f"[200 OK] {path}")
            found.append(path)
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        if 'does not exist' not in body:
            print(f"[{e.code}] {path} -> {body}")
            found.append(path)
    except Exception as e:
         pass

print("\n--- FOUND ENDPOINTS ---")
for f in found:
    print(f)
