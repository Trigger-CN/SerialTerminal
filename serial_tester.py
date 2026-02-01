import serial
import serial.tools.list_ports
import random
import time
import string

# 字符集定义
ENGLISH = string.ascii_letters
NUMBERS = string.digits
SYMBOLS = string.punctuation
# 常用中文字符
CHINESE = "你好世界测试串口通信数据发送接收工程师程序稳定性性能调试工具开发"
# 常用Emoji
EMOJIS = "😀😁😂🤣😃😄😅😆😉😊😎😍😘🥰😗😙😚☺🙂🤗🤩🤔🤨😐😑😶🙄😏😣😥😮🤐😯😪😫😴😌😛😜😝🤤😒😓😔😕🙃🤑😲☹🙁😖😞😟😤😢😭😦😧😨😩🤯😬😰😱🥵🥶😳🤪😵🥴😠😡🤬😷🤒🤕🤢🤮🤧😇🤠🥳🥴🥺"

def get_random_string(length=20):
    chars = []
    # 确保每种类型至少包含一个
    chars.append(random.choice(ENGLISH))
    chars.append(random.choice(NUMBERS))
    chars.append(random.choice(SYMBOLS))
    chars.append(random.choice(CHINESE))
    chars.append(random.choice(EMOJIS))
    
    # 剩余长度随机填充
    all_chars = ENGLISH + NUMBERS + SYMBOLS + CHINESE + EMOJIS
    for _ in range(length - 5):
        chars.append(random.choice(all_chars))
    
    # 打乱顺序
    random.shuffle(chars)
    return "".join(chars)

def list_ports():
    ports = serial.tools.list_ports.comports()
    return [port.device for port in ports]

def main():
    print("正在扫描可用串口...")
    ports = list_ports()
    
    if not ports:
        print("未发现可用串口！请检查连接。")
        # 为了演示，如果没有串口，我们可以模拟打印
        print("提示：如果没有真实串口，可以安装虚拟串口软件进行测试。")
        return

    print("可用串口列表:")
    for i, port in enumerate(ports):
        print(f"{i}: {port}")
    
    try:
        selection = input("请选择串口序号 (默认 0): ").strip()
        idx = int(selection) if selection else 0
        if idx < 0 or idx >= len(ports):
            print("无效的选择。")
            return
        port_name = ports[idx]
    except ValueError:
        print("输入无效。")
        return

    baud_rate = 9600
    try:
        baud_input = input(f"请输入波特率 (默认 {baud_rate}): ").strip()
        if baud_input:
            baud_rate = int(baud_input)
    except ValueError:
        print("波特率无效，将使用默认值。")

    try:
        # 打开串口
        ser = serial.Serial(port_name, baud_rate, timeout=1)
        print(f"\n成功打开串口 {port_name} (波特率: {baud_rate})")
        print("开始发送数据... (按 Ctrl+C 停止)")
        
        count = 0
        while True:
            count += 1
            # 随机生成 10 到 30 个字符的长度
            text = get_random_string(random.randint(10, 30))
            
            # 添加换行符，模拟通常的行传输
            message = text + "\n"
            
            # 编码为 utf-8 发送
            data = message.encode('utf-8')
            ser.write(data)
            
            print(f"[{count}] 已发送: {text}")
            
            time.sleep(0.03)
            
    except serial.SerialException as e:
        print(f"打开串口失败: {e}")
    except KeyboardInterrupt:
        print("\n已停止发送。")
    finally:
        if 'ser' in locals() and ser.is_open:
            ser.close()
            print("串口已关闭。")

if __name__ == "__main__":
    main()
