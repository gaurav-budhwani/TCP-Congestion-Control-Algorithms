# TCP-Congestion-Control-Algorithms
**Overview:** An Interactive simulation platform that demonstrates how different TCP congestion control algorithms work under varying network conditions, such as bandwidth, delay, and packet loss. It provides visualization of throughput, congestion window changes, and retransmission behavior.
<img width="968" height="626" alt="Screenshot 2025-11-12 at 10 35 16 PM" src="https://github.com/user-attachments/assets/cb607198-e964-4804-af15-7b0d3eb0298c" />
To run this project locally:
### For Backend:
```
Build ns3
cd TCP-Congestion-Control-Algorithms/ns3/
./ns3 build
```
### Run the Backend
```
git clone https://github.com/gaurav-budhwani/TCP-Congestion-Control-Algorithms.git
cd TCP-Congestion-Control-Algorithms/backend/python app.py
```

### Run the frontend:
```
cd TCP-Congestion-Control-Algorithms/frontend
npm run dev 
```

### Tech Stack Used
Python, JavaScript,  React for GUI; Matplotlib for graphs; simulation frameworks like ns-3 or custom-built network models.

## Some Results
### TCP Reno | CUBIC | BBR (using Python)
<img width="1107" height="537" alt="Screenshot 2025-11-12 at 11 30 28 PM" src="https://github.com/user-attachments/assets/7f6cc9da-858d-4243-839c-d776ce975210" />

### TCP Reno | CUBIC | BBR (using ns3)
<img width="924" height="507" alt="Screenshot 2025-11-12 at 11 32 53 PM" src="https://github.com/user-attachments/assets/699c91eb-2514-4dcd-9170-5f9581e3754d" />



