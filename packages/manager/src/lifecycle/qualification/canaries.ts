export const qualificationImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsItiNKMazQi+hcEKLNXzWgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELgt2zgEtldSC/gAAAABJRU5ErkJggg==";

export function imageCanary(prompt: string) {
	return `import json,urllib.error,urllib.request; pixel='${qualificationImageBase64}'; body=json.dumps({'model':'Qwen/Qwen3.5-4B','messages':[{'role':'user','content':[{'type':'image_url','image_url':{'url':'data:image/png;base64,'+pixel}},{'type':'text','text':${JSON.stringify(prompt)}}]}],'max_tokens':8}).encode(); request=urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions',data=body,headers={'content-type':'application/json'});\ntry: urllib.request.urlopen(request,timeout=120).read(); print('ready')\nexcept urllib.error.HTTPError as error: raise SystemExit('http_%s:%s' % (error.code,error.read(512).decode(errors='replace')))`;
}
