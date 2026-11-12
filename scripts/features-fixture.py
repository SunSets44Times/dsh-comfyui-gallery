import sys
from pathlib import Path
from PIL import Image, ImageDraw, PngImagePlugin

root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
graph = '{"1":{"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"base.safetensors"}},"2":{"class_type":"CLIPTextEncode","inputs":{"text":"mountain sunrise","clip":["1",1]}},"3":{"class_type":"LoraLoader","inputs":{"model":["1",0],"lora_name":"detail.safetensors","strength_model":0.8}},"4":{"class_type":"KSampler","inputs":{"model":["3",0],"positive":["2",0],"seed":123,"steps":20,"cfg":7,"sampler_name":"euler"}},"5":{"class_type":"SaveImage","inputs":{"images":["4",0],"filename_prefix":"test"}}}'
info = PngImagePlugin.PngInfo(); info.add_text('prompt', graph); info.add_text('workflow', '{"nodes":[{"id":4,"type":"KSampler"}]}')
image = Image.new('RGB', (320, 240), '#7ca6c7'); draw = ImageDraw.Draw(image)
draw.ellipse((210, 20, 270, 80), fill='#ffe39a'); draw.polygon([(0,230),(130,45),(290,240)], fill='#325345'); draw.polygon([(140,240),(260,120),(320,230)], fill='#456a48')
image.save(root/'landscape.png', pnginfo=info)
image.resize((640,480)).save(root/'landscape-copy.jpg', quality=90)
image = Image.new('RGB', (320,240), '#f3e2d0'); draw = ImageDraw.Draw(image)
draw.rectangle((40,25,100,215), fill='#aa3355'); draw.ellipse((125,45,285,205), fill='#243a70'); draw.line((0,0,320,240), fill='black', width=20)
image.save(root/'geometry.png', pnginfo=info)
